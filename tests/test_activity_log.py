from __future__ import annotations

import asyncio
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.config import Settings, User
from app.routes_browse import DeleteRequest, MkdirRequest, RenameRequest, create_folder, delete_entry, rename_entry
from app.tasks import db, runner
from app.tasks.routes import (
    TransferRequest,
    cancel_task,
    clear_activity,
    create_transfer,
    delete_all_completed_tasks,
    delete_task,
    get_activity,
)


class TestActivityLogIntegration(unittest.TestCase):
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
            users=[User(username="test_user", password_hash="hash")],
            secret_key="secret",
            session_max_age=3600,
            secure_cookie=False,
            data_dir=self.data_dir,
            host="127.0.0.1",
            port=8000,
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_mkdir_creates_activity(self):
        with patch("app.routes_browse.get_settings", return_value=self.settings):
            req = MkdirRequest(path=str(self.dest_dir), name="NewFolder2026")
            res = asyncio.run(create_folder(req, _user="test_user"))
            self.assertTrue(res["success"])

            activities = db.list_activity()
            self.assertEqual(len(activities), 1)
            entry = activities[0]
            self.assertEqual(entry["kind"], "mkdir")
            msg = json.loads(entry["message"])
            self.assertEqual(msg["operation"], "mkdir")
            self.assertEqual(msg["status"], "succeeded")
            self.assertEqual(msg["name"], "NewFolder2026")
            self.assertIn("NewFolder2026", msg["path"])

    def test_rename_creates_activity(self):
        target_file = self.dest_dir / "old_name.mkv"
        target_file.write_text("content")

        with patch("app.routes_browse.get_settings", return_value=self.settings):
            req = RenameRequest(path=str(target_file), new_name="new_name.mkv")
            res = asyncio.run(rename_entry(req, _user="test_user"))
            self.assertTrue(res["success"])

            activities = db.list_activity()
            self.assertEqual(len(activities), 1)
            entry = activities[0]
            self.assertEqual(entry["kind"], "rename")
            msg = json.loads(entry["message"])
            self.assertEqual(msg["operation"], "rename")
            self.assertEqual(msg["status"], "succeeded")
            self.assertEqual(msg["old_name"], "old_name.mkv")
            self.assertEqual(msg["new_name"], "new_name.mkv")
            self.assertEqual(msg["summary"], "old_name.mkv → new_name.mkv")

    def test_delete_creates_activity(self):
        target_file = self.dest_dir / "temp_file.log"
        target_file.write_text("log content")

        with patch("app.routes_browse.get_settings", return_value=self.settings):
            req = DeleteRequest(path=str(target_file))
            res = asyncio.run(delete_entry(req, _user="test_user"))
            self.assertTrue(res["success"])

            activities = db.list_activity()
            self.assertEqual(len(activities), 1)
            entry = activities[0]
            self.assertEqual(entry["kind"], "delete")
            msg = json.loads(entry["message"])
            self.assertEqual(msg["operation"], "delete")
            self.assertEqual(msg["status"], "succeeded")
            self.assertEqual(msg["name"], "temp_file.log")

    def test_queued_transfer_does_not_create_activity(self):
        file1 = self.source_dir / "queued_file.txt"
        file1.write_text("data")

        with patch("app.tasks.routes.get_settings", return_value=self.settings):
            req = TransferRequest(
                sources=[str(file1)],
                destination=str(self.dest_dir),
                operation="copy",
            )
            res = asyncio.run(create_transfer(req, user="test_user"))
            self.assertEqual(len(res["task_ids"]), 1)

            # Queued state must NOT produce an activity entry
            activities = db.list_activity()
            self.assertEqual(len(activities), 0)

            # Task must be in tasks table
            task = db.get_task(res["task_ids"][0])
            self.assertEqual(task["status"], "queued")

    def test_completed_copy_transfer_creates_activity(self):
        file1 = self.source_dir / "report.pdf"
        file1.write_text("pdf data")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(file1),
            destination=str(self.dest_dir),
            operation="copy",
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)
        asyncio.run(runner._run_task(task, self.settings))

        # Check task completion
        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "succeeded")

        # Check Activity Log
        activities = db.list_activity()
        self.assertEqual(len(activities), 1)
        entry = activities[0]
        self.assertEqual(entry["kind"], "transfer")
        msg = json.loads(entry["message"])
        self.assertEqual(msg["operation"], "copy")
        self.assertEqual(msg["status"], "succeeded")
        self.assertEqual(msg["name"], "report.pdf")
        self.assertIn("report.pdf", msg["summary"])
        self.assertNotIn("[source deleted]", msg["summary"])

    def test_completed_move_transfer_creates_activity(self):
        file1 = self.source_dir / "movie.mkv"
        file1.write_text("movie data")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(file1),
            destination=str(self.dest_dir),
            operation="move",
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)
        asyncio.run(runner._run_task(task, self.settings))

        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "succeeded")

        # Check Activity Log
        activities = db.list_activity()
        self.assertEqual(len(activities), 1)
        entry = activities[0]
        self.assertEqual(entry["kind"], "transfer")
        msg = json.loads(entry["message"])
        self.assertEqual(msg["operation"], "move")
        self.assertEqual(msg["status"], "succeeded")
        self.assertEqual(msg["name"], "movie.mkv")
        self.assertIn("[source deleted]", msg["summary"])

    def test_failed_transfer_creates_activity(self):
        # Create collision on destination to trigger overwrite guard failure
        source_file = self.source_dir / "broken_file.mkv"
        source_file.write_text("source content")
        dest_collision = self.dest_dir / "broken_file.mkv"
        dest_collision.write_text("dest content")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(source_file),
            destination=str(self.dest_dir),
            operation="move",
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)
        asyncio.run(runner._run_task(task, self.settings))

        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "failed")

        activities = db.list_activity()
        self.assertEqual(len(activities), 1)
        entry = activities[0]
        self.assertEqual(entry["kind"], "transfer")
        msg = json.loads(entry["message"])
        self.assertEqual(msg["operation"], "move")
        self.assertEqual(msg["status"], "failed")
        self.assertEqual(msg["name"], "broken_file.mkv")
        self.assertIn("already exists", msg["summary"])

    def test_interrupted_cancelled_transfer_creates_activity(self):
        task_id = runner.queue_task(
            settings=self.settings,
            source=str(self.source_dir / "large_backup.tar"),
            destination=str(self.dest_dir),
            operation="copy",
        )

        with patch("app.tasks.routes.get_settings", return_value=self.settings):
            res = asyncio.run(cancel_task(task_id, _user="test_user"))
            self.assertEqual(res, {"success": True})

            finished = db.get_task(task_id)
            self.assertEqual(finished["status"], "interrupted")

            activities = db.list_activity()
            self.assertEqual(len(activities), 1)
            entry = activities[0]
            self.assertEqual(entry["kind"], "transfer")
            msg = json.loads(entry["message"])
            self.assertEqual(msg["operation"], "copy")
            self.assertEqual(msg["status"], "interrupted")
            self.assertEqual(msg["name"], "large_backup.tar")
            self.assertIn("cancelled by user", msg["summary"].lower())

    def test_reconcile_on_startup_crash_recovery_creates_activity(self):
        """Simulated crash-restart reconciliation:
        A task left in 'running' state in SQLite when the server starts
        must be marked 'interrupted' by reconcile_on_startup and produce
        an Activity Log entry."""
        task_id = "crashed_task_uuid"
        db.insert_task(
            id=task_id,
            source=str(self.source_dir / "interrupted_backup.iso"),
            destination=str(self.dest_dir),
            operation="move",
            status="running",
            started_at=db.now_iso(),
        )

        # Confirm no activity entry exists prior to startup
        self.assertEqual(len(db.list_activity()), 0)

        # Run startup reconciliation
        runner.reconcile_on_startup(self.settings)

        # Task must be interrupted
        task = db.get_task(task_id)
        self.assertEqual(task["status"], "interrupted")
        self.assertEqual(task["error_message"], "Server restarted during transfer")

        # Activity log must record the crash recovery interruption
        activities = db.list_activity()
        self.assertEqual(len(activities), 1)
        entry = activities[0]
        self.assertEqual(entry["kind"], "transfer")
        msg = json.loads(entry["message"])
        self.assertEqual(msg["operation"], "move")
        self.assertEqual(msg["status"], "interrupted")
        self.assertEqual(msg["name"], "interrupted_backup.iso")
        self.assertEqual(msg["error"], "Server restarted during transfer")

    def test_multi_source_transfer_produces_independent_activity_entries(self):
        """Multi-source transfer submission (Prompt 6 fan-out model):
        Submitting 3 sources creates 3 tasks.
        Each task individually finishes with its own outcome and produces
        one independent Activity Log entry."""
        f1 = self.source_dir / "multi_a.txt"
        f2 = self.source_dir / "multi_b.txt"
        f3 = self.source_dir / "multi_c.txt"
        f1.write_text("a")
        f2.write_text("b")
        f3.write_text("c")

        with patch("app.tasks.routes.get_settings", return_value=self.settings):
            req = TransferRequest(
                sources=[str(f1), str(f2), str(f3)],
                destination=str(self.dest_dir),
                operation="copy",
            )
            res = asyncio.run(create_transfer(req, user="test_user"))
            task_ids = res["task_ids"]
            self.assertEqual(len(task_ids), 3)

            # Initially 0 activity entries
            self.assertEqual(len(db.list_activity()), 0)

            # Task 1 succeeds
            db.mark_running(task_ids[0])
            t1 = db.get_task(task_ids[0])
            asyncio.run(runner._run_task(t1, self.settings))

            act1 = db.list_activity()
            self.assertEqual(len(act1), 1)
            msg1 = json.loads(act1[0]["message"])
            self.assertEqual(msg1["name"], "multi_a.txt")
            self.assertEqual(msg1["status"], "succeeded")

            # Task 2 fails (e.g. simulated error)
            db.mark_running(task_ids[1])
            db.mark_finished(task_ids[1], "failed", 23, "rsync exit 23")

            act2 = db.list_activity()
            self.assertEqual(len(act2), 2)
            msg2 = json.loads(act2[0]["message"])  # newest first
            self.assertEqual(msg2["name"], "multi_b.txt")
            self.assertEqual(msg2["status"], "failed")

            # Task 3 is cancelled
            asyncio.run(cancel_task(task_ids[2], _user="test_user"))

            act3 = db.list_activity()
            self.assertEqual(len(act3), 3)
            names = [json.loads(a["message"])["name"] for a in act3]
            self.assertIn("multi_a.txt", names)
            self.assertIn("multi_b.txt", names)
            self.assertIn("multi_c.txt", names)

    def test_deleting_task_does_not_delete_activity(self):
        """Activity log entries must outlive task cleanup."""
        f1 = self.source_dir / "cleanup_test.txt"
        f1.write_text("cleanup")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(f1),
            destination=str(self.dest_dir),
            operation="copy",
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)
        asyncio.run(runner._run_task(task, self.settings))

        # Confirm activity exists
        self.assertEqual(len(db.list_activity()), 1)

        # Delete single task via API
        with patch("app.tasks.routes.get_settings", return_value=self.settings):
            asyncio.run(delete_task(task_id, _user="test_user"))
            self.assertIsNone(db.get_task(task_id))

            # Activity record MUST still exist
            self.assertEqual(len(db.list_activity()), 1)

            # Delete all completed tasks via API
            asyncio.run(delete_all_completed_tasks(_user="test_user"))
            self.assertEqual(len(db.list_activity()), 1)

    def test_get_and_delete_activity_api(self):
        db.add_activity("mkdir", {"operation": "mkdir", "name": "dir1", "status": "succeeded"})
        db.add_activity("delete", {"operation": "delete", "name": "file1", "status": "succeeded"})

        # Test GET /api/activity
        res = asyncio.run(get_activity(limit=10, offset=0, _user="test_user"))
        self.assertIn("activity", res)
        self.assertEqual(len(res["activity"]), 2)
        self.assertEqual(res["activity"][0]["kind"], "delete")
        self.assertEqual(res["activity"][1]["kind"], "mkdir")

        # Test DELETE /api/activity
        del_res = asyncio.run(clear_activity(_user="test_user"))
        self.assertEqual(del_res, {"success": True})
        self.assertEqual(len(db.list_activity()), 0)

    def test_activity_persistence_across_db_reopen(self):
        db.add_activity("transfer", {"operation": "copy", "name": "doc.pdf", "status": "succeeded"})
        self.assertEqual(len(db.list_activity()), 1)

        # Reopen / re-init DB
        db.init_db(self.data_dir)
        items = db.list_activity()
        self.assertEqual(len(items), 1)
        msg = json.loads(items[0]["message"])
        self.assertEqual(msg["name"], "doc.pdf")


if __name__ == "__main__":
    unittest.main()
