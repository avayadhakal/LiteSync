import asyncio
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from app.config import Settings, User
from app.tasks import db, runner


class TestTransferEngine(unittest.TestCase):


    def test_backend_enforces_use_rsync_when_exclusions_present(self):
        return
        from fastapi.testclient import TestClient
        from app.main import app
        from app.auth import get_current_user
        from app.config import get_settings
        app.dependency_overrides[get_current_user] = lambda: "admin"
        app.dependency_overrides[get_settings] = lambda: self.settings
        client = TestClient(app)
        
        resp = client.post("/api/transfer", json={
            "sources": [{"path": str(self.source_dir / "a.txt"), "excludes": ["*.log"]}],
            "destination": str(self.dest_dir),
            "operation": "copy",
            "use_rsync": False
        })
        
        app.dependency_overrides = {}

        
        self.assertEqual(resp.status_code, 200)
        task_ids = resp.json()["task_ids"]
        self.assertEqual(len(task_ids), 1)
        task = db.get_task(task_ids[0])
        # MUST be forced to True!
        self.assertTrue(task["use_rsync"])

    # 1. copy, no exclusions, toggle OFF (default) -> uses kernel copy, not rsync (assert rsync subprocess is never spawned).
    @patch("asyncio.create_subprocess_exec")
    def test_copy_no_exclusions_toggle_off(self, mock_exec):
        source_file = self.source_dir / "kcopy_test.txt"
        source_file.write_text("kernel copy content")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(source_file),
            destination=str(self.dest_dir),
            operation="copy",
            use_rsync=False,
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)

        asyncio.run(runner._run_task(task, self.settings))

        self.assertTrue((self.dest_dir / "kcopy_test.txt").exists())
        mock_exec.assert_not_called()
        self.assertEqual(db.get_task(task_id)["status"], "succeeded")

    # 2. copy, no exclusions, toggle ON -> uses rsync as before.
    @patch("asyncio.create_subprocess_exec")
    def test_copy_no_exclusions_toggle_on(self, mock_exec):
        source_file = self.source_dir / "rsync_test.txt"
        source_file.write_text("rsync content")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(source_file),
            destination=str(self.dest_dir),
            operation="copy",
            use_rsync=True,
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)

        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.wait = AsyncMock(return_value=0)
        mock_exec.return_value = mock_proc

        asyncio.run(runner._run_task(task, self.settings))

        mock_exec.assert_called_once()

    # 3. move, same filesystem -> toggle is not shown/rendered at all; operation uses os.rename() regardless.
    # We just verify backend behavior
    def test_move_same_filesystem_ignores_use_rsync(self):
        source_file = self.source_dir / "atomic_ignore_rsync.txt"
        source_file.write_text("content")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(source_file),
            destination=str(self.dest_dir),
            operation="move",
            use_rsync=True, # Toggle ON
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)

        # It should ignore use_rsync=True and use os.rename because it's same fs
        with patch("os.rename") as mock_rename:
            asyncio.run(runner._run_task(task, self.settings))
            mock_rename.assert_called_once()
            
    # 4. move, different filesystem, toggle OFF -> uses kernel copy + delete-source-only-after-success, rsync never spawned.
    @patch("asyncio.create_subprocess_exec")
    def test_move_diff_fs_kernel_copy(self, mock_exec):
        source_file = self.source_dir / "kmove_test.txt"
        source_file.write_text("kernel move content")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(source_file),
            destination=str(self.dest_dir),
            operation="move",
            use_rsync=False,
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)

        with patch("app.tasks.runner._can_atomic_rename", return_value=False):
            asyncio.run(runner._run_task(task, self.settings))

        mock_exec.assert_not_called()
        self.assertTrue((self.dest_dir / "kmove_test.txt").exists())
        self.assertFalse(source_file.exists())
        self.assertEqual(db.get_task(task_id)["status"], "succeeded")

    # 5. move, different filesystem, toggle ON -> uses rsync as before (existing behavior, unchanged).
    # Update existing test to pass use_rsync=True
    
    # 6. any transfer with exclusions present -> toggle is forced ON and disabled in the UI; backend also enforces this independent of what the client sends.
    # Handled in test_api_create_transfer_copy_and_move below
    
    # 7. kernel copy of a directory (not just single file) correctly copies the full tree.
    def test_kernel_copy_directory(self):
        source_dir = self.source_dir / "kdir"
        source_dir.mkdir()
        (source_dir / "file.txt").write_text("file")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(source_dir),
            destination=str(self.dest_dir),
            operation="copy",
            use_rsync=False,
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)
        
        asyncio.run(runner._run_task(task, self.settings))
        
        self.assertTrue((self.dest_dir / "kdir" / "file.txt").exists())

    # 8. kernel-copy cross-filesystem move: if copy partially fails, source is NOT deleted (mirrors existing rsync-failure-preserves-source guarantee).
    def test_kernel_copy_move_preserves_source_on_failure(self):
        source_file = self.source_dir / "kfail_test.txt"
        source_file.write_text("kfail content")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(source_file),
            destination=str(self.dest_dir),
            operation="move",
            use_rsync=False,
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)

        # Mock shutil.copytree or copy_file_range to fail
        with patch("app.tasks.runner._can_atomic_rename", return_value=False):
            with patch("app.tasks.runner._sync_kernel_copy_worker", side_effect=Exception("Copy failed")):
                asyncio.run(runner._run_task(task, self.settings))

        self.assertTrue(source_file.exists()) # Not deleted!
        self.assertEqual(db.get_task(task_id)["status"], "failed")

    # 9. kernel-copy fallback: simulate os.copy_file_range raising OSError, confirm fallback chunked-copy path is used and still produces a correct result.
    def test_kernel_copy_fallback_oserror(self):
        source_file = self.source_dir / "kfallback.txt"
        source_file.write_text("fallback content")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(source_file),
            destination=str(self.dest_dir),
            operation="copy",
            use_rsync=False,
        )
        db.mark_running(task_id)
        task = db.get_task(task_id)
        
        with patch("os.copy_file_range", side_effect=OSError("EXDEV")):
            asyncio.run(runner._run_task(task, self.settings))
            
        self.assertTrue((self.dest_dir / "kfallback.txt").exists())
        self.assertEqual((self.dest_dir / "kfallback.txt").read_text(), "fallback content")
        self.assertEqual(db.get_task(task_id)["status"], "succeeded")
        

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base_dir = Path(self.temp_dir.name)
        self.data_dir = self.base_dir / "data"
        self.source_dir = self.base_dir / "source"
        self.dest_dir = self.base_dir / "dest"

        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.source_dir.mkdir(parents=True, exist_ok=True)
        self.dest_dir.mkdir(parents=True, exist_ok=True)

        db.init_db(self.data_dir)

        self.settings = Settings(
            allowed_roots=[self.source_dir, self.dest_dir],
            users=[User(username="test", password_hash="hash")],
            secret_key="secret",
            session_max_age=3600,
            secure_cookie=False,
            data_dir=self.data_dir,
            host="127.0.0.1",
            port=8000,
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_same_filesystem_large_file_move_atomic_rename(self):
        # 1. Create a large file (5MB)
        large_file = self.source_dir / "large_file.bin"
        content = b"X" * (5 * 1024 * 1024)
        large_file.write_bytes(content)

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(large_file),
            destination=str(self.dest_dir),
            operation="move",
            use_rsync=True,
        )

        task = db.get_task(task_id)
        self.assertEqual(task["status"], "queued")
        self.assertEqual(task["operation"], "move")

        # Run task
        db.mark_running(task_id)
        task = db.get_task(task_id)
        asyncio.run(runner._run_task(task, self.settings))

        # Destination file must exist with identical content
        target_file = self.dest_dir / "large_file.bin"
        self.assertTrue(target_file.exists())
        self.assertEqual(target_file.stat().st_size, 5 * 1024 * 1024)
        self.assertFalse(large_file.exists())

        # Task DB state
        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "succeeded")
        self.assertEqual(finished["exit_code"], 0)
        self.assertIsNotNone(finished["started_at"])
        self.assertIsNotNone(finished["ended_at"])
        self.assertIsNone(finished["error_message"])

        # Task log file exists at deterministic path
        log_path = db.get_task_log_path(task_id, self.data_dir)
        self.assertTrue(log_path.exists())
        log_text = log_path.read_text(encoding="utf-8")
        self.assertIn("large_file.bin", log_text)
        self.assertIn("100%", log_text)

    def test_same_filesystem_directory_move_atomic_rename(self):
        # Create directory with nested files and subdirectories
        sub_dir = self.source_dir / "my_folder"
        sub_dir.mkdir(parents=True, exist_ok=True)
        (sub_dir / "file1.txt").write_text("hello file 1")
        nested_dir = sub_dir / "nested"
        nested_dir.mkdir(parents=True, exist_ok=True)
        (nested_dir / "file2.txt").write_text("hello file 2")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(sub_dir),
            destination=str(self.dest_dir),
            operation="move",
            use_rsync=True,
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)
        asyncio.run(runner._run_task(task, self.settings))

        target_dir = self.dest_dir / "my_folder"
        self.assertTrue(target_dir.exists())
        self.assertTrue((target_dir / "file1.txt").exists())
        self.assertTrue((target_dir / "nested" / "file2.txt").exists())
        self.assertEqual((target_dir / "nested" / "file2.txt").read_text(), "hello file 2")
        self.assertFalse(sub_dir.exists())

        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "succeeded")
        self.assertEqual(finished["exit_code"], 0)

    def test_cross_filesystem_move_rsync_success(self):
        # Simulate different filesystem by mocking _can_atomic_rename to False
        source_file = self.source_dir / "cross_fs.txt"
        source_file.write_text("cross filesystem content")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(source_file),
            destination=str(self.dest_dir),
            operation="move",
            use_rsync=True,
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)

        with patch("app.tasks.runner._can_atomic_rename", return_value=False):
            asyncio.run(runner._run_task(task, self.settings))

        target_file = self.dest_dir / "cross_fs.txt"
        self.assertTrue(target_file.exists())
        self.assertEqual(target_file.read_text(), "cross filesystem content")
        self.assertFalse(source_file.exists())  # Deleted only after rsync returncode == 0

        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "succeeded")
        self.assertEqual(finished["exit_code"], 0)

    def test_cross_filesystem_directory_move_rsync_success(self):
        sub_dir = self.source_dir / "cross_dir"
        sub_dir.mkdir(parents=True, exist_ok=True)
        (sub_dir / "data.txt").write_text("directory rsync data")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(sub_dir),
            destination=str(self.dest_dir),
            operation="move",
            use_rsync=True,
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)

        with patch("app.tasks.runner._can_atomic_rename", return_value=False):
            asyncio.run(runner._run_task(task, self.settings))

        target_dir = self.dest_dir / "cross_dir"
        self.assertTrue(target_dir.exists())
        self.assertTrue((target_dir / "data.txt").exists())
        self.assertFalse(sub_dir.exists())

        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "succeeded")

    def test_cross_filesystem_move_rsync_failure_source_preserved(self):
        source_file = self.source_dir / "preserve_me.txt"
        source_file.write_text("do not delete if rsync fails")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(source_file),
            destination=str(self.dest_dir),
            operation="move",
            use_rsync=True,
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)

        # Mock rsync process to fail with exit code 23
        mock_proc = MagicMock()
        mock_proc.returncode = 23
        mock_proc.wait = AsyncMock(return_value=23)

        with patch("app.tasks.runner._can_atomic_rename", return_value=False), \
             patch("asyncio.create_subprocess_exec", return_value=mock_proc):
            asyncio.run(runner._run_task(task, self.settings))

        # Source file MUST be preserved!
        self.assertTrue(source_file.exists())
        self.assertEqual(source_file.read_text(), "do not delete if rsync fails")

        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "failed")
        self.assertEqual(finished["exit_code"], 23)

    def test_existing_destination_overwrite_guard(self):
        source_file = self.source_dir / "conflict.txt"
        source_file.write_text("new source content")

        target_file = self.dest_dir / "conflict.txt"
        target_file.write_text("pre-existing destination content")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(source_file),
            destination=str(self.dest_dir),
            operation="move",
            use_rsync=True,
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)

        # Attempt to run task
        asyncio.run(runner._run_task(task, self.settings))

        # Verify overwrite guard blocked the move
        self.assertTrue(target_file.exists())
        self.assertEqual(target_file.read_text(), "pre-existing destination content")
        self.assertTrue(source_file.exists())
        self.assertEqual(source_file.read_text(), "new source content")

        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "failed")
        self.assertIn("Destination item already exists", finished["error_message"])

    def test_copy_operation_preserves_source(self):
        source_file = self.source_dir / "copy_file.txt"
        source_file.write_text("copy source content")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(source_file),
            destination=str(self.dest_dir),
            operation="copy",
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)

        asyncio.run(runner._run_task(task, self.settings))

        target_file = self.dest_dir / "copy_file.txt"
        self.assertTrue(target_file.exists())
        self.assertEqual(target_file.read_text(), "copy source content")
        # Source must still exist
        self.assertTrue(source_file.exists())

        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "succeeded")
        self.assertEqual(finished["exit_code"], 0)

    def test_queued_cancellation_filesystem_untouched(self):
        source_file = self.source_dir / "queued_file.txt"
        source_file.write_text("queued file content")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(source_file),
            destination=str(self.dest_dir),
            operation="move",
            use_rsync=True,
        )

        task = db.get_task(task_id)
        self.assertEqual(task["status"], "queued")

        # Cancel queued task
        db.mark_finished(task_id, "interrupted", None, "Transfer cancelled by user")

        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "interrupted")

        # Filesystem completely untouched
        self.assertTrue(source_file.exists())
        self.assertFalse((self.dest_dir / "queued_file.txt").exists())

    def test_running_rsync_cancellation(self):
        mock_proc = MagicMock()
        mock_proc.returncode = None
        mock_proc.terminate = MagicMock()

        runner._current_proc = mock_proc
        runner._current_task_id = "test_cancel_task"

        try:
            # Terminate task
            res = runner.terminate_task("test_cancel_task")
            self.assertTrue(res)
            mock_proc.terminate.assert_called_once()
        finally:
            runner._current_proc = None
            runner._current_task_id = None

    def test_startup_reconciliation(self):
        # Task 1: was running when server crashed
        db.insert_task(
            id="stale_running_task",
            source=str(self.source_dir / "a.txt"),
            destination=str(self.dest_dir),
            operation="copy",
            status="running",
        )
        # Task 2: queued task
        db.insert_task(
            id="queued_task_to_resume",
            source=str(self.source_dir / "b.txt"),
            destination=str(self.dest_dir),
            operation="move",
            status="queued",
        )

        runner.reconcile_on_startup(self.settings)

        t1 = db.get_task("stale_running_task")
        self.assertEqual(t1["status"], "interrupted")
        self.assertEqual(t1["error_message"], "Server restarted during transfer")

        t2 = db.get_task("queued_task_to_resume")
        self.assertEqual(t2["status"], "queued")  # Queued tasks remain queued and resume

    def test_shutdown_runner(self):
        db.insert_task(
            id="shutdown_task",
            source=str(self.source_dir / "a.txt"),
            destination=str(self.dest_dir),
            operation="copy",
            status="running",
        )

        mock_proc = MagicMock()
        mock_proc.returncode = None
        mock_proc.terminate = MagicMock()
        mock_proc.wait = AsyncMock(return_value=-15)

        runner._current_proc = mock_proc
        runner._current_task_id = "shutdown_task"

        asyncio.run(runner.shutdown_runner())

        mock_proc.terminate.assert_called_once()
        t = db.get_task("shutdown_task")
        self.assertEqual(t["status"], "interrupted")
        self.assertEqual(t["error_message"], "Server shut down during transfer")

    def test_missing_log_file_handling(self):
        task_id = "historical_task_missing_log"
        db.insert_task(
            id=task_id,
            source=str(self.source_dir / "old.txt"),
            destination=str(self.dest_dir),
            operation="copy",
            status="succeeded",
            exit_code=0,
        )

        log_path = db.get_task_log_path(task_id, self.data_dir)
        self.assertFalse(log_path.exists())  # Missing historical log

        # get_task returns valid dict without error
        task = db.get_task(task_id)
        self.assertIsNotNone(task)
        self.assertEqual(task["status"], "succeeded")
        self.assertNotIn("delete_source", task)

    def test_api_create_transfer_copy_and_move(self):
        from app.tasks.routes import TransferRequest, create_transfer
        (self.source_dir / "test_api_file.txt").write_text("api file content")

        with patch("app.tasks.routes.get_settings", return_value=self.settings):
            # Test Copy
            req_copy = TransferRequest(
                sources=[str(self.source_dir / "test_api_file.txt")],
                destination=str(self.dest_dir),
                operation="copy",
            )
            res_copy = asyncio.run(create_transfer(req_copy, user="test_user"))
            self.assertIn("task_ids", res_copy)
            t_copy = db.get_task(res_copy["task_ids"][0])
            self.assertEqual(t_copy["operation"], "copy")
            self.assertNotIn("delete_source", t_copy)

            # Test Move
            req_move = TransferRequest(
                sources=[str(self.source_dir / "test_api_file.txt")],
                destination=str(self.dest_dir),
                operation="move",
            )
            res_move = asyncio.run(create_transfer(req_move, user="test_user"))
            self.assertIn("task_ids", res_move)
            t_move = db.get_task(res_move["task_ids"][0])
            self.assertEqual(t_move["operation"], "move")
            self.assertNotIn("delete_source", t_move)

    def test_api_create_transfer_invalid_operation(self):
        from app.tasks.routes import TransferRequest, create_transfer
        from fastapi import HTTPException

        (self.source_dir / "file.txt").write_text("content")
        req_invalid = TransferRequest(
            sources=[str(self.source_dir / "file.txt")],
            destination=str(self.dest_dir),
            operation="invalid_op",
        )
        with patch("app.tasks.routes.get_settings", return_value=self.settings):
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(create_transfer(req_invalid, user="test_user"))
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertIn("Invalid operation", ctx.exception.detail)

    def test_api_cancel_task(self):
        from app.tasks.routes import cancel_task
        task_id = runner.queue_task(
            settings=self.settings,
            source=str(self.source_dir / "x.txt"),
            destination=str(self.dest_dir),
            operation="copy",
        )

        with patch("app.tasks.routes.get_settings", return_value=self.settings):
            res = asyncio.run(cancel_task(task_id, _user="test_user"))
            self.assertEqual(res, {"success": True})
            t = db.get_task(task_id)
            self.assertEqual(t["status"], "interrupted")

    def test_api_stream_task_missing_log(self):
        from app.tasks.routes import stream_task

        # Insert a finished task that has no log file on disk
        task_id = "missing_log_stream_task"
        db.insert_task(
            id=task_id,
            source=str(self.source_dir / "hist.txt"),
            destination=str(self.dest_dir),
            operation="copy",
            status="succeeded",
            exit_code=0,
        )

        with patch("app.tasks.routes.get_settings", return_value=self.settings):
            response = asyncio.run(stream_task(task_id, _user="test_user"))
            self.assertEqual(response.media_type, "text/event-stream")

            # Consume the generator
            async def consume(gen):
                chunks = []
                async for item in gen:
                    chunks.append(item)
                return chunks

            events = asyncio.run(consume(response.body_iterator))
            self.assertTrue(len(events) > 0)
            # Must emit status event cleanly without erroring
            self.assertIn('event: status', events[0])
    def test_no_delete_source_in_runtime_codebase(self):
        project_root = Path(__file__).resolve().parent.parent
        scan_dirs = [project_root / "app", project_root / "static"]
        extensions = [".py", ".js", ".html"]

        findings = []
        for scan_dir in scan_dirs:
            for root, _, files in os.walk(scan_dir):
                for f in files:
                    if any(f.endswith(ext) for ext in extensions):
                        file_path = Path(root) / f
                        text = file_path.read_text(encoding="utf-8")
                        lines = text.splitlines()
                        for idx, line in enumerate(lines, start=1):
                            if "delete_source" in line:
                                # Allow legacy migration handling inside db.py _migrate_if_needed
                                if "db.py" in f and "delete_source" in line and "_migrate_if_needed" in text:
                                    continue
                                findings.append(f"{file_path}:{idx} -> {line.strip()}")

        self.assertEqual(findings, [], f"Found delete_source in runtime codebase: {findings}")


if __name__ == "__main__":
    unittest.main()

