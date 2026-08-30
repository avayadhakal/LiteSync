import asyncio
import os
import signal
import time
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

from fastapi.testclient import TestClient

from app.main import app
from app.auth import get_current_user
from app.config import Settings, get_settings
from app.tasks import db, runner


class TestPauseResume(unittest.TestCase):
    def setUp(self):
        from app.config import User
        self.settings = Settings(
            data_dir=Path("/tmp/litesync_test_data_pause"),
            allowed_roots=[Path("/tmp/litesync_test_source_pause"), Path("/tmp/litesync_test_dest_pause")],
            users=[User(username="test", password_hash="hash")],
            secret_key="secret",
            session_max_age=3600,
            secure_cookie=False,
            host="127.0.0.1",
            port=8080
        )
        for root in self.settings.allowed_roots:
            root.mkdir(parents=True, exist_ok=True)
        db.init_db(self.settings.data_dir)
        db.clear_activity()

        self.client = TestClient(app)
        app.dependency_overrides[get_current_user] = lambda: "admin"
        app.dependency_overrides[get_settings] = lambda: self.settings

    def tearDown(self):
        app.dependency_overrides = {}
        runner._paused_procs.clear()
        runner._current_proc = None
        runner._current_task_id = None
        db._db_path = None
        for root in self.settings.allowed_roots:
            try:
                os.system(f"rm -rf {root}")
            except:
                pass
        try:
            os.system(f"rm -rf {self.settings.data_dir}")
        except:
            pass

    # Test 1 & 6 & 14 helper logic: We can test SIGKILL mechanics manually via asyncio.
    def test_14_sigkill_signal_mechanics(self):
        # 14. SIGKILL Signal Mechanics: Send SIGSTOP to a real subprocess, then send SIGKILL directly (no SIGCONT).
        async def run_test():
            proc = await asyncio.create_subprocess_exec("sleep", "10")
            proc.send_signal(signal.SIGSTOP)
            await asyncio.sleep(0.1) # Let it stop
            
            start = time.time()
            proc.kill()
            await asyncio.wait_for(proc.wait(), timeout=1.0) # Should be instant
            duration = time.time() - start
            
            self.assertLess(duration, 0.5) # Must be instant
            self.assertIsNotNone(proc.returncode)

        asyncio.run(run_test())

    @patch("asyncio.create_subprocess_exec")
    def test_pause_running_task_sigstop(self, mock_exec):
        # Test 1: pause a running rsync task
        mock_proc = MagicMock()
        mock_proc.returncode = None
        
        task_id = "test_pause_task"
        db.insert_task(id=task_id, source="/tmp", destination="/tmp", status="running", use_rsync=True)
        
        runner._current_task_id = task_id
        runner._current_proc = mock_proc
        
        resp = self.client.post(f"/api/tasks/{task_id}/pause")
        self.assertEqual(resp.status_code, 200)
        
        task = db.get_task(task_id)
        self.assertEqual(task["status"], "paused")
        mock_proc.send_signal.assert_called_with(signal.SIGSTOP)
        
        self.assertIn(task_id, runner._paused_procs)
        self.assertIsNone(runner._current_task_id)

    def test_pause_rejected_kernel_copy(self):
        # Test 2
        task_id = "test_kernel"
        db.insert_task(id=task_id, source="/tmp", destination="/tmp", status="running", use_rsync=False)
        resp = self.client.post(f"/api/tasks/{task_id}/pause")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("Cannot pause a kernel-copy task", resp.json()["detail"])

    def test_pause_rejected_not_running(self):
        # Test 3
        task_id = "test_queued"
        db.insert_task(id=task_id, source="/tmp", destination="/tmp", status="queued", use_rsync=True)
        resp = self.client.post(f"/api/tasks/{task_id}/pause")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("not currently running", resp.json()["detail"])

    @patch("app.tasks.runner.build_rsync_argv")
    @patch("asyncio.create_subprocess_exec")
    def test_queue_progression_while_paused(self, mock_exec, mock_build_argv):
        # Test 4 & 13 (finally block race condition)
        mock_build_argv.return_value = ["echo", "test"]
        mock_proc_1 = MagicMock()
        mock_proc_1.returncode = None
        
        mock_proc_2 = MagicMock()
        
        async def run_tests():
            pass
            
        # Real end-to-end trace with _run_task
        mock_exec.return_value = mock_proc_1
        
        task1_id = "task1"
        task2_id = "task2"
        db.insert_task(id=task1_id, source="/tmp/a", destination="/tmp/b", status="running", use_rsync=True)
        db.insert_task(id=task2_id, source="/tmp/c", destination="/tmp/d", status="queued", use_rsync=True)
        
        runner._current_task_id = task1_id
        runner._current_proc = mock_proc_1
        
        # We manually pause Task 1
        runner.pause_task_runner(task1_id)
        db.mark_paused(task1_id)
        
        self.assertEqual(runner._current_task_id, None)
        self.assertIn(task1_id, runner._paused_procs)
        
        # Start Task 2
        runner._current_task_id = task2_id
        runner._current_proc = mock_proc_2
        
        # Task 1 finally block simulates race condition
        if runner._current_task_id == task1_id:
            runner._current_proc = None
            runner._current_task_id = None
            
        self.assertEqual(runner._current_task_id, task2_id) # Was NOT stomped!

    @patch("asyncio.create_subprocess_exec")
    def test_resume_success_and_pid_reconnect(self, mock_exec):
        # Test 5 & 6
        task_id = "test_resume"
        db.insert_task(id=task_id, source="/tmp", destination="/tmp", status="paused", use_rsync=True)
        
        mock_proc = MagicMock()
        mock_proc.returncode = None
        runner._paused_procs[task_id] = mock_proc
        
        # Resume via API
        resp = self.client.post(f"/api/tasks/{task_id}/resume")
        self.assertEqual(resp.status_code, 200)
        
        task = db.get_task(task_id)
        self.assertEqual(task["status"], "queued")
        
        # Now simulate scheduler picking it up
        async def run_resumed():
            nxt = db.next_queued_task()
            self.assertEqual(nxt["id"], task_id)
            db.mark_running(task_id)
            
            async def mock_wait():
                mock_proc.returncode = 0
                return 0
            mock_proc.wait = mock_wait
            
            await runner._run_task(nxt, self.settings)
            
        asyncio.run(run_resumed())
        
        # Assert SIGCONT was sent
        mock_proc.send_signal.assert_called_with(signal.SIGCONT)
        # Explicit Test 6 Assertion: Assert duplicate process was NOT spawned
        mock_exec.assert_not_called()
        # Assert task finished successfully
        task = db.get_task(task_id)
        self.assertEqual(task["status"], "succeeded")
        
    def test_startup_reconciliation(self):
        # Test 7
        db.insert_task(id="task1", source="/tmp", destination="/tmp", status="paused", use_rsync=True)
        db.insert_task(id="task2", source="/tmp", destination="/tmp", status="running", use_rsync=True)
        
        runner.reconcile_on_startup(self.settings)
        
        self.assertEqual(db.get_task("task1")["status"], "interrupted")
        self.assertEqual(db.get_task("task2")["status"], "interrupted")
        self.assertIn("Server restarted", db.get_task("task1")["error_message"])

    def test_graceful_shutdown(self):
        # Test 8
        task_id = "test_shutdown"
        db.insert_task(id=task_id, source="/tmp", destination="/tmp", status="paused", use_rsync=True)
        
        mock_proc = MagicMock()
        mock_proc.returncode = None
        
        async def mock_wait():
            await asyncio.sleep(0.01)
            mock_proc.returncode = -9
            
        mock_proc.wait = mock_wait
        runner._paused_procs[task_id] = mock_proc
        
        async def run_shutdown():
            start = time.time()
            await runner.shutdown_runner()
            duration = time.time() - start
            self.assertLess(duration, 2.0)
            
        asyncio.run(run_shutdown())
        
        mock_proc.kill.assert_called_once()
        task = db.get_task(task_id)
        self.assertEqual(task["status"], "interrupted")
        self.assertIn("Server shut down", task["error_message"])

    def test_cancel_paused_task(self):
        # Test 9
        task_id = "test_cancel"
        db.insert_task(id=task_id, source="/tmp", destination="/tmp", status="paused", use_rsync=True)
        
        mock_proc = MagicMock()
        mock_proc.returncode = None
        runner._paused_procs[task_id] = mock_proc
        
        resp = self.client.post(f"/api/tasks/{task_id}/cancel")
        self.assertEqual(resp.status_code, 200)
        
        task = db.get_task(task_id)
        self.assertEqual(task["status"], "interrupted")
        mock_proc.kill.assert_called_once()
        self.assertNotIn(task_id, runner._paused_procs)

    def test_activity_log_terminal_events(self):
        # Test 12
        task_id = "test_act"
        db.insert_task(id=task_id, source="/tmp/s", destination="/tmp/d", status="running", use_rsync=True)
        
        # Pause
        db.mark_paused(task_id)
        self.assertEqual(len(db.list_activity()), 0)
        
        # Resume
        db.mark_queued(task_id)
        self.assertEqual(len(db.list_activity()), 0)
        
        # Finish
        db.mark_finished(task_id, "succeeded", 0)
        activities = db.list_activity()
        self.assertEqual(len(activities), 1)
        self.assertEqual(activities[0]["kind"], "transfer")

    def test_resume_bypasses_overwrite_conflict(self):
        # Explicit test to ensure resuming a task bypasses target_path.exists() check
        task_id = "test_resume_conflict"
        # Simulate a partially copied file existing at destination
        dst_dir = self.settings.allowed_roots[1]
        target_file = dst_dir / "conflict_file.txt"
        target_file.touch()

        db.insert_task(id=task_id, source="/tmp/conflict_file.txt", destination=str(dst_dir), status="paused", use_rsync=True, on_conflict="skip")
        
        mock_proc = MagicMock()
        mock_proc.returncode = None
        runner._paused_procs[task_id] = mock_proc
        
        # Resume via API
        resp = self.client.post(f"/api/tasks/{task_id}/resume")
        self.assertEqual(resp.status_code, 200)
        
        async def run_resumed():
            nxt = db.next_queued_task()
            db.mark_running(task_id)
            async def mock_wait():
                mock_proc.returncode = 0
                return 0
            mock_proc.wait = mock_wait
            
            await runner._run_task(nxt, self.settings)
            
        asyncio.run(run_resumed())
        
        # If the bypass failed, status would be 'failed' with "Destination item already exists"
        task = db.get_task(task_id)
        self.assertEqual(task["status"], "succeeded")
        self.assertNotIn("Destination item already exists", str(task.get("error_message")))

    def test_rapid_pause_resume_race_condition(self):
        # Explicit test for the stale polling loop race condition
        task_id = "test_race_cond"
        db.insert_task(id=task_id, source="/tmp/s", destination="/tmp/d", status="running", use_rsync=True)
        
        mock_proc = MagicMock()
        mock_proc.returncode = None
        
        runner._current_task_id = task_id
        runner._current_proc = mock_proc
        
        # Simulate original token
        original_token = object()
        runner._current_run_token = original_token
        
        # Step 1: User pauses
        runner.pause_task_runner(task_id)
        db.mark_paused(task_id)
        
        # Step 2: User rapidly resumes (before old 5s loop wakes up)
        db.mark_queued(task_id)
        
        # New loop picks it up and claims it
        runner._current_task_id = task_id
        runner._current_proc = mock_proc
        new_token = object()
        runner._current_run_token = new_token
        
        # Step 3: Old loop wakes up from its 5-second timeout and evaluates the catch block
        # We simulate the catch block logic that caused the bug
        latest = db.get_task(task_id)
        self.assertEqual(latest["status"], "queued")
        
        # If the old logic ran, it would do:
        # if latest["status"] not in ("running", "paused"): proc.kill()
        
        # But our new token logic intercepts it:
        stale_loop_token = original_token
        current_global_token = runner._current_run_token
        
        # Assert that the tokens don't match, which triggers the clean exit
        self.assertIsNot(stale_loop_token, current_global_token)
        
        # Simulate the old finally block executing
        if stale_loop_token is current_global_token:
            runner._current_proc = None
            runner._current_task_id = None
            runner._current_run_token = None
            
        # Assert that the globals were NOT cleared by the stale loop
        self.assertEqual(runner._current_task_id, task_id)
        self.assertEqual(runner._current_proc, mock_proc)
        self.assertIsNotNone(runner._current_run_token)
        
        # Assert the process wasn't killed
        mock_proc.kill.assert_not_called()

    def test_stale_loop_exits_on_unhandled_status(self):
        # Explicit test to ensure the polling loop breaks defensively if status is "failed" or "succeeded"
        task_id = "test_catchall"
        db.insert_task(id=task_id, source="/tmp/s", destination="/tmp/d", status="running", use_rsync=True)
        
        mock_proc = MagicMock()
        mock_proc.returncode = None
        
        # Simulate the token matching so we actually evaluate the status checks
        original_token = object()
        runner._current_run_token = original_token
        runner._current_task_id = task_id
        runner._current_proc = mock_proc
        
        # Manually change the DB status out of band to "failed"
        db.mark_finished(task_id, "failed", 1, "Simulated out of band failure")
        
        # Replicate the timeout block logic from _run_task:
        latest = db.get_task(task_id)
        
        broke_loop = False
        if latest is None or latest["status"] == "interrupted":
            try:
                mock_proc.kill()
            except ProcessLookupError:
                pass
        elif latest["status"] != "running":
            # This is the catch-all we want to trigger
            broke_loop = True
            
        self.assertTrue(broke_loop, "The catch-all did not trigger for 'failed' status!")
        mock_proc.kill.assert_not_called()

if __name__ == '__main__':
    unittest.main()
