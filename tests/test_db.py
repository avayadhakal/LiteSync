import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from app.tasks import db


class TestDatabaseSchemaAndTasks(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        db.init_db(self.data_dir)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_init_db_creates_tables_and_indexes(self):
        with db._connect() as conn:
            # Check tables
            tables = {
                row["name"]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                ).fetchall()
            }
            self.assertIn("tasks", tables)
            self.assertIn("activity", tables)

            # Check tasks columns
            task_cols = {
                row["name"]: row["type"]
                for row in conn.execute("PRAGMA table_info(tasks)").fetchall()
            }
            expected_task_cols = {
                "id": "TEXT",
                "source": "TEXT",
                "destination": "TEXT",
                "operation": "TEXT",
                "status": "TEXT",
                "created_at": "TEXT",
                "started_at": "TEXT",
                "ended_at": "TEXT",
                "exit_code": "INTEGER",
                "error_message": "TEXT",
                "excludes": "TEXT",
            "use_rsync": "INTEGER",
            }
            self.assertEqual(task_cols, expected_task_cols)

            # Ensure legacy columns are NOT in the database table
            self.assertNotIn("sources", task_cols)
            self.assertNotIn("delete_source", task_cols)
            self.assertNotIn("tmux_session", task_cols)
            self.assertNotIn("log_path", task_cols)
            self.assertNotIn("created_by", task_cols)

            # Check activity columns
            activity_cols = {
                row["name"]: row["type"]
                for row in conn.execute("PRAGMA table_info(activity)").fetchall()
            }
            expected_activity_cols = {
                "id": "INTEGER",
                "kind": "TEXT",
                "message": "TEXT",
                "created_at": "TEXT",
            }
            self.assertEqual(activity_cols, expected_activity_cols)

            # Check indexes
            indexes = {
                row["name"]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='index'"
                ).fetchall()
            }
            self.assertIn("idx_tasks_status", indexes)
            self.assertIn("idx_tasks_created_at", indexes)
            self.assertIn("idx_activity_created", indexes)

    def test_insert_and_get_task(self):
        task_id = "task_uuid_123"
        db.insert_task(
            id=task_id,
            source="/mnt/source/file.txt",
            destination="/mnt/dest",
            operation="copy",
        )

        task = db.get_task(task_id)
        self.assertIsNotNone(task)
        # Authoritative fields
        self.assertEqual(task["id"], task_id)
        self.assertEqual(task["source"], "/mnt/source/file.txt")
        self.assertEqual(task["destination"], "/mnt/dest")
        self.assertEqual(task["operation"], "copy")
        self.assertEqual(task["status"], "queued")
        self.assertIsNotNone(task["created_at"])
        self.assertIsNone(task["started_at"])
        self.assertIsNone(task["ended_at"])
        self.assertIsNone(task["exit_code"])
        self.assertIsNone(task["error_message"])

        # Field assertions
        self.assertEqual(task["task_id"], task_id)
        self.assertNotIn("sources", task)
        self.assertNotIn("delete_source", task)
        self.assertNotIn("log_path", task)

    def test_insert_task_move_operation(self):
        task_id = "task_uuid_move"
        db.insert_task(
            id=task_id,
            source="/mnt/source/movie.mkv",
            destination="/mnt/dest",
            operation="move",
        )

        task = db.get_task(task_id)
        self.assertIsNotNone(task)
        self.assertEqual(task["operation"], "move")
        self.assertNotIn("delete_source", task)

    def test_insert_task_sources_kwarg(self):
        task_id = "task_uuid_sources_kwarg"
        db.insert_task(
            task_id=task_id,
            sources=["/mnt/source/legacy.bin"],
            destination="/mnt/dest",
            operation="move",
        )

        task = db.get_task(task_id)
        self.assertIsNotNone(task)
        self.assertEqual(task["id"], task_id)
        self.assertEqual(task["source"], "/mnt/source/legacy.bin")
        self.assertEqual(task["operation"], "move")
        self.assertNotIn("delete_source", task)

    def test_task_lifecycle_transitions(self):
        task_id = "task_lifecycle"
        db.insert_task(
            id=task_id,
            source="/mnt/source/a.txt",
            destination="/mnt/dest",
            operation="copy",
        )

        # Queued
        task = db.get_task(task_id)
        self.assertEqual(task["status"], "queued")
        self.assertIsNone(task["started_at"])

        # Mark Running
        db.mark_running(task_id)
        task = db.get_task(task_id)
        self.assertEqual(task["status"], "running")
        self.assertIsNotNone(task["started_at"])
        self.assertIsNone(task["ended_at"])

        # Mark Finished (succeeded)
        db.mark_finished(task_id, status="succeeded", exit_code=0)
        task = db.get_task(task_id)
        self.assertEqual(task["status"], "succeeded")
        self.assertEqual(task["exit_code"], 0)
        self.assertIsNotNone(task["ended_at"])
        self.assertIsNone(task["error_message"])

    def test_task_lifecycle_failed_and_interrupted(self):
        task_fail = "task_fail"
        db.insert_task(id=task_fail, source="/s1", destination="/d1", operation="copy")
        db.mark_running(task_fail)
        db.mark_finished(task_fail, status="failed", exit_code=23, error_message="rsync error 23")

        t1 = db.get_task(task_fail)
        self.assertEqual(t1["status"], "failed")
        self.assertEqual(t1["exit_code"], 23)
        self.assertEqual(t1["error_message"], "rsync error 23")

        task_int = "task_int"
        db.insert_task(id=task_int, source="/s2", destination="/d2", operation="move")
        db.mark_running(task_int)
        db.mark_finished(task_int, status="interrupted", exit_code=None, error_message="Server restarted")

        t2 = db.get_task(task_int)
        self.assertEqual(t2["status"], "interrupted")
        self.assertIsNone(t2["exit_code"])
        self.assertEqual(t2["error_message"], "Server restarted")

    def test_list_tasks_and_pagination(self):
        for i in range(10):
            db.insert_task(
                id=f"task_{i:02d}",
                source=f"/src_{i}",
                destination="/dst",
                created_at=f"2026-08-28T10:{i:02d}:00Z",
            )

        tasks = db.list_tasks(limit=5, offset=0)
        self.assertEqual(len(tasks), 5)
        # Newest first
        self.assertEqual(tasks[0]["id"], "task_09")
        self.assertEqual(tasks[4]["id"], "task_05")

        tasks_page2 = db.list_tasks(limit=5, offset=5)
        self.assertEqual(len(tasks_page2), 5)
        self.assertEqual(tasks_page2[0]["id"], "task_04")
        self.assertEqual(tasks_page2[4]["id"], "task_00")

    def test_queued_and_running_queries(self):
        db.insert_task(id="q1", source="/s1", destination="/d", created_at="2026-08-28T10:00:00Z")
        db.insert_task(id="q2", source="/s2", destination="/d", created_at="2026-08-28T10:01:00Z")
        db.insert_task(id="r1", source="/s3", destination="/d", created_at="2026-08-28T10:02:00Z")
        db.insert_task(id="s1", source="/s4", destination="/d", created_at="2026-08-28T10:03:00Z")

        db.mark_running("r1")
        db.mark_finished("s1", "succeeded", 0)

        # Queued list (FIFO order: ASC)
        queued = db.list_queued_tasks()
        self.assertEqual([t["id"] for t in queued], ["q1", "q2"])

        # Next queued
        nxt = db.next_queued_task()
        self.assertIsNotNone(nxt)
        self.assertEqual(nxt["id"], "q1")

        # Running tasks query (includes queued + running)
        running = db.list_running_tasks()
        self.assertEqual({t["id"] for t in running}, {"q1", "q2", "r1"})

    def test_delete_task(self):
        db.insert_task(id="del_me", source="/s", destination="/d")
        self.assertIsNotNone(db.get_task("del_me"))
        db.delete_task("del_me")
        self.assertIsNone(db.get_task("del_me"))


class TestActivityLog(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        db.init_db(self.data_dir)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_add_and_list_activity(self):
        id1 = db.add_activity("transfer", "Transfer /a -> /b queued", created_at="2026-08-28T10:00:00Z")
        id2 = db.add_activity("delete", "Deleted file /a/foo", created_at="2026-08-28T10:01:00Z")
        id3 = db.add_activity("mkdir", "Created directory /a/bar", created_at="2026-08-28T10:02:00Z")

        self.assertGreater(id1, 0)
        self.assertGreater(id2, id1)
        self.assertGreater(id3, id2)

        items = db.list_activity()
        self.assertEqual(len(items), 3)
        # Newest first
        self.assertEqual(items[0]["kind"], "mkdir")
        self.assertEqual(items[1]["kind"], "delete")
        self.assertEqual(items[2]["kind"], "transfer")

    def test_clear_activity(self):
        db.insert_task(id="t1", source="/s", destination="/d")
        db.add_activity("transfer", "Started t1")
        db.add_activity("transfer", "Completed t1")

        self.assertEqual(len(db.list_activity()), 2)
        db.clear_activity()
        self.assertEqual(len(db.list_activity()), 0)

        # Task history must remain unaffected
        self.assertIsNotNone(db.get_task("t1"))

    def test_prune_activity(self):
        for i in range(10):
            db.add_activity("info", f"Message {i:02d}", created_at=f"2026-08-28T10:{i:02d}:00Z", max_entries=0)

        self.assertEqual(len(db.list_activity(limit=100)), 10)
        deleted = db.prune_activity(keep_limit=3)
        self.assertEqual(deleted, 7)

        remaining = db.list_activity(limit=100)
        self.assertEqual(len(remaining), 3)
        self.assertEqual([r["message"] for r in remaining], ["Message 09", "Message 08", "Message 07"])

    def test_add_activity_auto_prune(self):
        for i in range(8):
            db.add_activity("info", f"Auto {i:02d}", created_at=f"2026-08-28T10:{i:02d}:00Z", max_entries=5)

        remaining = db.list_activity(limit=100)
        self.assertEqual(len(remaining), 5)
        self.assertEqual([r["message"] for r in remaining], ["Auto 07", "Auto 06", "Auto 05", "Auto 04", "Auto 03"])

    def test_activity_persistence_across_reopen(self):
        db.add_activity("test", "Persistent message")
        # Re-initialize DB at same path
        db.init_db(self.data_dir)
        items = db.list_activity()
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["kind"], "test")
        self.assertEqual(items[0]["message"], "Persistent message")


class TestDatabaseMigration(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        self.db_path = self.data_dir / "litesync.db"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_migration_from_legacy_schema(self):
        # Create legacy schema table directly
        conn = sqlite3.connect(self.db_path)
        conn.executescript("""
        CREATE TABLE tasks (
            task_id       TEXT PRIMARY KEY,
            status        TEXT NOT NULL,
            sources       TEXT NOT NULL,
            destination   TEXT NOT NULL,
            delete_source INTEGER NOT NULL DEFAULT 0,
            created_by    TEXT NOT NULL,
            created_at    TEXT NOT NULL,
            started_at    TEXT,
            ended_at      TEXT,
            exit_code     INTEGER,
            tmux_session  TEXT NOT NULL,
            log_path      TEXT NOT NULL,
            error_message TEXT
        );
        """)

        # Insert 1 single-source copy task
        conn.execute(
            """
            INSERT INTO tasks VALUES (
                'uuid_single_copy', 'succeeded', '["/mnt/ssd/doc.pdf"]', '/mnt/hdd',
                0, 'pi', '2026-08-26T17:00:00Z', '2026-08-26T17:00:01Z', '2026-08-26T17:01:00Z',
                0, 'litesync-session', '/var/log/1', NULL
            )
            """
        )

        # Insert 1 single-source move task with error
        conn.execute(
            """
            INSERT INTO tasks VALUES (
                'uuid_single_move', 'failed', '["/mnt/ssd/fail.bin"]', '/mnt/hdd',
                1, 'pi', '2026-08-26T18:00:00Z', '2026-08-26T18:00:01Z', '2026-08-26T18:01:00Z',
                23, 'litesync-session', '/var/log/2', 'Permission denied'
            )
            """
        )

        # Insert 1 multi-source task (3 sources)
        conn.execute(
            """
            INSERT INTO tasks VALUES (
                'uuid_multi', 'succeeded', '["/mnt/ssd/m1", "/mnt/ssd/m2", "/mnt/ssd/m3"]', '/mnt/hdd/movies',
                1, 'pi', '2026-08-26T19:00:00Z', '2026-08-26T19:00:01Z', '2026-08-26T19:05:00Z',
                0, 'litesync-session', '/var/log/3', NULL
            )
            """
        )
        conn.commit()
        conn.close()

        # Run init_db which triggers migration
        db.init_db(self.data_dir)

        # Verify schema
        with db._connect() as conn:
            cols = {row["name"] for row in conn.execute("PRAGMA table_info(tasks)").fetchall()}
            self.assertNotIn("sources", cols)
            self.assertNotIn("delete_source", cols)
            self.assertNotIn("tmux_session", cols)
            self.assertNotIn("log_path", cols)
            self.assertNotIn("created_by", cols)
            self.assertIn("source", cols)
            self.assertIn("operation", cols)

            # Count total tasks (1 + 1 + 3 = 5)
            count = conn.execute("SELECT count(*) FROM tasks").fetchone()[0]
            self.assertEqual(count, 5)

        # Verify single copy
        t1 = db.get_task("uuid_single_copy")
        self.assertIsNotNone(t1)
        self.assertEqual(t1["source"], "/mnt/ssd/doc.pdf")
        self.assertEqual(t1["destination"], "/mnt/hdd")
        self.assertEqual(t1["operation"], "copy")
        self.assertEqual(t1["status"], "succeeded")
        self.assertEqual(t1["exit_code"], 0)

        # Verify single move with error
        t2 = db.get_task("uuid_single_move")
        self.assertIsNotNone(t2)
        self.assertEqual(t2["source"], "/mnt/ssd/fail.bin")
        self.assertEqual(t2["destination"], "/mnt/hdd")
        self.assertEqual(t2["operation"], "move")
        self.assertEqual(t2["status"], "failed")
        self.assertEqual(t2["exit_code"], 23)
        self.assertEqual(t2["error_message"], "Permission denied")

        # Verify multi-source split
        m0 = db.get_task("uuid_multi")
        m1 = db.get_task("uuid_multi_1")
        m2 = db.get_task("uuid_multi_2")
        self.assertIsNotNone(m0)
        self.assertIsNotNone(m1)
        self.assertIsNotNone(m2)

        self.assertEqual(m0["source"], "/mnt/ssd/m1")
        self.assertEqual(m1["source"], "/mnt/ssd/m2")
        self.assertEqual(m2["source"], "/mnt/ssd/m3")

        for m in [m0, m1, m2]:
            self.assertEqual(m["destination"], "/mnt/hdd/movies")
            self.assertEqual(m["operation"], "move")
            self.assertEqual(m["status"], "succeeded")
            self.assertEqual(m["created_at"], "2026-08-26T19:00:00Z")
            self.assertEqual(m["exit_code"], 0)

    def test_migration_idempotence(self):
        # Fresh DB init
        db.init_db(self.data_dir)
        db.insert_task(id="task_x", source="/sx", destination="/dx", operation="copy")

        # Second init_db should be clean no-op
        db.init_db(self.data_dir)
        t = db.get_task("task_x")
        self.assertIsNotNone(t)
        self.assertEqual(t["source"], "/sx")


if __name__ == "__main__":
    unittest.main()
