import asyncio
from datetime import datetime, timezone, timedelta
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, MagicMock

from fastapi.testclient import TestClient

from app.auth import get_current_user
from app.config import Settings, User, get_settings
from app.main import app
from app.transfers import db, scheduler


class TestScheduledTransfers(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base_dir = Path(self.temp_dir.name)
        self.data_dir = self.base_dir / "data"
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.source_dir = self.base_dir / "source"
        self.source_dir.mkdir(parents=True, exist_ok=True)
        self.dest_dir = self.base_dir / "dest"
        self.dest_dir.mkdir(parents=True, exist_ok=True)

        db.init_db(self.data_dir)

        self.settings = Settings(
            allowed_roots=[self.source_dir, self.dest_dir],
            secret_key="test_secret_for_scheduled_transfers",
            session_max_age=3600,
            secure_cookie=False,
            download_expiry=7200,
            data_dir=self.data_dir,
            host="127.0.0.1",
            port=8000,
            allowed_origins=["http://testserver", "http://127.0.0.1:8000"],
            users=[User(username="testuser", password_hash="dummy")],
        )

        from app import config as app_config
        self.orig_settings = app_config._settings
        app_config._settings = self.settings

        app.dependency_overrides[get_current_user] = lambda: "testuser"
        app.dependency_overrides[get_settings] = lambda: self.settings
        self.client = TestClient(app, headers={"Origin": "http://127.0.0.1:8000"})

    def tearDown(self):
        from app import config as app_config
        app_config._settings = self.orig_settings
        app.dependency_overrides = {}
        self.temp_dir.cleanup()

    # 1. Submitting with future scheduled_for creates task with status=scheduled, not picked up immediately
    def test_future_scheduled_task_created_and_not_picked_up_immediately(self):
        src_file = self.source_dir / "test1.txt"
        src_file.write_text("hello scheduled")

        future_iso = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
        resp = self.client.post("/api/transfer", json={
            "sources": [str(src_file)],
            "destination": str(self.dest_dir),
            "operation": "copy",
            "scheduled_for": future_iso,
        })
        self.assertEqual(resp.status_code, 200)
        task_ids = resp.json()["task_ids"]
        self.assertEqual(len(task_ids), 1)
        task_id = task_ids[0]

        task = db.get_task(task_id)
        self.assertIsNotNone(task)
        self.assertEqual(task["status"], "scheduled")
        self.assertEqual(task["scheduled_for"], future_iso)

        # Scheduler must NOT pick this up
        self.assertIsNone(db.next_queued_task())
        self.assertEqual(len(db.list_queued_tasks()), 0)

    # 2. Scheduled task whose time has arrived gets flipped to queued on promotion
    def test_due_scheduled_task_promotes_to_queued(self):
        src_file = self.source_dir / "test2.txt"
        src_file.write_text("hello due")

        future_iso = (datetime.now(timezone.utc) + timedelta(minutes=30)).isoformat()
        resp = self.client.post("/api/transfer", json={
            "sources": [str(src_file)],
            "destination": str(self.dest_dir),
            "operation": "copy",
            "scheduled_for": future_iso,
        })
        task_id = resp.json()["task_ids"][0]

        # Simulate time arriving by updating scheduled_for directly to the past
        past_iso = (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()
        with db._lock, db._connect() as conn:
            conn.execute("UPDATE tasks SET scheduled_for=? WHERE id=?", (past_iso, task_id))

        promoted = db.promote_due_scheduled_tasks()
        self.assertIn(task_id, promoted)

        task = db.get_task(task_id)
        self.assertEqual(task["status"], "queued")
        self.assertEqual(db.next_queued_task()["id"], task_id)

    # 3. Startup reconciliation: task with past scheduled_for is flipped to queued
    def test_startup_reconciliation_promotes_past_scheduled_task(self):
        past_iso = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        task_id = scheduler.queue_task(
            settings=self.settings,
            source=str(self.source_dir / "missed.txt"),
            destination=str(self.dest_dir),
            operation="copy",
            scheduled_for=past_iso,
        )
        self.assertEqual(db.get_task(task_id)["status"], "scheduled")

        # Run startup reconciliation
        scheduler.reconcile_on_startup(self.settings)

        task = db.get_task(task_id)
        self.assertEqual(task["status"], "queued")

    # 4. Startup reconciliation: task with future scheduled_for remains untouched
    def test_startup_reconciliation_leaves_future_scheduled_task_untouched(self):
        future_iso = (datetime.now(timezone.utc) + timedelta(hours=5)).isoformat()
        task_id = scheduler.queue_task(
            settings=self.settings,
            source=str(self.source_dir / "future.txt"),
            destination=str(self.dest_dir),
            operation="copy",
            scheduled_for=future_iso,
        )
        self.assertEqual(db.get_task(task_id)["status"], "scheduled")

        # Run startup reconciliation
        scheduler.reconcile_on_startup(self.settings)

        task = db.get_task(task_id)
        self.assertEqual(task["status"], "scheduled")
        self.assertEqual(task["scheduled_for"], future_iso)

    # 5. Cancelling scheduled task marks it interrupted, never runs, and does NOT signal processes
    @patch("app.transfers.routes.terminate_task")
    @patch("app.transfers.routes.terminate_paused_task")
    def test_cancel_scheduled_task_bypasses_process_signaling(self, mock_term_paused, mock_term):
        future_iso = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        task_id = scheduler.queue_task(
            settings=self.settings,
            source=str(self.source_dir / "cancel_me.txt"),
            destination=str(self.dest_dir),
            operation="copy",
            scheduled_for=future_iso,
        )

        resp = self.client.post(f"/api/tasks/{task_id}/cancel")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json(), {"success": True})

        task = db.get_task(task_id)
        self.assertEqual(task["status"], "interrupted")

        # Explicitly verify process termination functions were NEVER called
        mock_term.assert_not_called()
        mock_term_paused.assert_not_called()

        # Promotion should not pick it up
        promoted = db.promote_due_scheduled_tasks()
        self.assertNotIn(task_id, promoted)
        self.assertIsNone(db.next_queued_task())

    # 6. Scheduled task produces NO Activity Log entry when scheduled
    def test_scheduled_task_produces_no_activity_log_at_schedule_time(self):
        initial_activity = db.list_activity()
        self.assertEqual(len(initial_activity), 0)

        src_file = self.source_dir / "activity_test.txt"
        src_file.write_text("data")
        future_iso = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()
        resp = self.client.post("/api/transfer", json={
            "sources": [str(src_file)],
            "destination": str(self.dest_dir),
            "operation": "copy",
            "scheduled_for": future_iso,
        })
        self.assertEqual(resp.status_code, 200)

        # Still 0 activity entries
        self.assertEqual(len(db.list_activity()), 0)

    # 7. Scheduled tasks do not appear in list_running_tasks()
    def test_scheduled_tasks_excluded_from_active_operations_query(self):
        future_iso = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        task_id = scheduler.queue_task(
            settings=self.settings,
            source=str(self.source_dir / "active_check.txt"),
            destination=str(self.dest_dir),
            operation="copy",
            scheduled_for=future_iso,
        )
        active_tasks = db.list_running_tasks()
        self.assertNotIn(task_id, [t["id"] for t in active_tasks])

    # 8. GET /api/tasks/scheduled returns all pending scheduled tasks sorted by scheduled_for ASC
    def test_get_scheduled_tasks_endpoint_sorting(self):
        t1 = (datetime.now(timezone.utc) + timedelta(hours=3)).isoformat()
        t2 = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        t3 = (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()

        id1 = scheduler.queue_task(self.settings, "/src/1", str(self.dest_dir), scheduled_for=t1)
        id2 = scheduler.queue_task(self.settings, "/src/2", str(self.dest_dir), scheduled_for=t2)
        id3 = scheduler.queue_task(self.settings, "/src/3", str(self.dest_dir), scheduled_for=t3)

        resp = self.client.get("/api/tasks/scheduled")
        self.assertEqual(resp.status_code, 200)
        tasks = resp.json()["tasks"]
        self.assertEqual(len(tasks), 3)
        # Expected order: t2 (1h), t3 (2h), t1 (3h)
        self.assertEqual([t["id"] for t in tasks], [id2, id3, id1])

    # 9. Regression test: Submitting without scheduled_for behaves completely unchanged
    def test_transfer_without_scheduled_for_backward_compatibility(self):
        src_file = self.source_dir / "immediate.txt"
        src_file.write_text("immediate content")

        resp = self.client.post("/api/transfer", json={
            "sources": [str(src_file)],
            "destination": str(self.dest_dir),
            "operation": "copy",
        })
        self.assertEqual(resp.status_code, 200)
        task_id = resp.json()["task_ids"][0]

        task = db.get_task(task_id)
        self.assertEqual(task["status"], "queued")
        self.assertIsNone(task.get("scheduled_for"))
        self.assertEqual(db.next_queued_task()["id"], task_id)

    # 10. Validation: invalid or past scheduled_for rejected with HTTP 400
    def test_invalid_or_past_scheduled_for_rejected(self):
        src_file = self.source_dir / "invalid.txt"
        src_file.write_text("content")

        # Past timestamp
        past_iso = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
        resp = self.client.post("/api/transfer", json={
            "sources": [str(src_file)],
            "destination": str(self.dest_dir),
            "scheduled_for": past_iso,
        })
        self.assertEqual(resp.status_code, 400)
        self.assertIn("must be in the future", resp.json()["detail"])

        # Malformed timestamp
        resp = self.client.post("/api/transfer", json={
            "sources": [str(src_file)],
            "destination": str(self.dest_dir),
            "scheduled_for": "not-a-date",
        })
        self.assertEqual(resp.status_code, 400)
        self.assertIn("Invalid scheduled_for timestamp", resp.json()["detail"])

    # 11. Concurrency boundary race condition test (Cancel vs. Promote)
    def test_boundary_race_cancel_vs_promote(self):
        import threading

        # Run multiple concurrent iterations with threading.Barrier to force true thread interleaving
        for i in range(10):
            past_iso = (datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
            task_id = scheduler.queue_task(
                settings=self.settings,
                source=str(self.source_dir / f"concurrent_race_{i}.txt"),
                destination=str(self.dest_dir),
                operation="copy",
                scheduled_for=past_iso,
            )

            barrier = threading.Barrier(2)
            cancel_res = {}
            promote_res = {}

            def cancel_thread_fn():
                try:
                    barrier.wait(timeout=5)
                    resp = self.client.post(f"/api/tasks/{task_id}/cancel")
                    cancel_res["status_code"] = resp.status_code
                    cancel_res["body"] = resp.json()
                except Exception as e:
                    cancel_res["error"] = e

            def promote_thread_fn():
                try:
                    barrier.wait(timeout=5)
                    promoted = db.promote_due_scheduled_tasks()
                    promote_res["promoted"] = promoted
                except Exception as e:
                    promote_res["error"] = e

            t_cancel = threading.Thread(target=cancel_thread_fn)
            t_promote = threading.Thread(target=promote_thread_fn)
            t_cancel.start()
            t_promote.start()
            t_cancel.join(timeout=5)
            t_promote.join(timeout=5)

            # Assert neither thread encountered unhandled exceptions or SQLite deadlock
            self.assertNotIn("error", cancel_res)
            self.assertNotIn("error", promote_res)
            self.assertEqual(cancel_res.get("status_code"), 200)

            # Assert that the task ends up in exactly ONE consistent terminal state: 'interrupted'
            final_task = db.get_task(task_id)
            self.assertEqual(
                final_task["status"],
                "interrupted",
                f"Iteration {i}: Task must end up in 'interrupted' terminal state",
            )

            # Ensure the task is not left as an active or queued item
            next_q = db.next_queued_task()
            if next_q:
                self.assertNotEqual(
                    next_q["id"],
                    task_id,
                    f"Iteration {i}: Cancelled task must not be in queued queue",
                )

    # 12. Deleting a pending scheduled task is rejected with 400
    def test_cannot_delete_pending_scheduled_task(self):
        future_iso = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        task_id = scheduler.queue_task(
            settings=self.settings,
            source=str(self.source_dir / "nodelete.txt"),
            destination=str(self.dest_dir),
            operation="copy",
            scheduled_for=future_iso,
        )
        resp = self.client.delete(f"/api/tasks/{task_id}")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("Cannot delete an active or scheduled task", resp.json()["detail"])
        self.assertIsNotNone(db.get_task(task_id))


if __name__ == "__main__":
    unittest.main()
