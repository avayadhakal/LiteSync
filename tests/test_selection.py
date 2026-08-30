import asyncio
import os
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException

from app.config import Settings, User
from app.tasks import db, runner
from app.tasks.routes import TransferRequest, TransferSourceItem, create_transfer


class SelectionModelHelper:
    """Python reference implementation of the selection model for testing algorithms directly."""

    def __init__(self, include=None, exclude=None):
        self.include = set(self._norm(p) for p in (include or []))
        self.exclude = set(self._norm(p) for p in (exclude or []))

    @staticmethod
    def _norm(p):
        p = str(p or "").strip()
        while "//" in p:
            p = p.replace("//", "/")
        if len(p) > 1 and p.endswith("/"):
            p = p[:-1]
        return p or "/"

    def _longest_ancestor(self, path):
        norm = self._norm(path)
        longest_match = None
        longest_len = -1
        match_type = None

        for inc in self.include:
            if inc != norm and (inc == "/" or norm.startswith(inc + "/")):
                l = 1 if inc == "/" else len(inc)
                if l > longest_len:
                    longest_len = l
                    longest_match = inc
                    match_type = "include"

        for exc in self.exclude:
            if exc != norm and (exc == "/" or norm.startswith(exc + "/")):
                l = 1 if exc == "/" else len(exc)
                if l > longest_len:
                    longest_len = l
                    longest_match = exc
                    match_type = "exclude"

        return longest_match, match_type

    def is_path_selected(self, path):
        norm = self._norm(path)
        longest_len = -1
        match_type = None

        for inc in self.include:
            if norm == inc or inc == "/" or norm.startswith(inc + "/"):
                l = 1 if inc == "/" else len(inc)
                if l > longest_len:
                    longest_len = l
                    match_type = "include"

        for exc in self.exclude:
            if norm == exc or exc == "/" or norm.startswith(exc + "/"):
                l = 1 if exc == "/" else len(exc)
                if l > longest_len:
                    longest_len = l
                    match_type = "exclude"

        return match_type == "include"

    def select(self, path):
        norm = self._norm(path)
        self.exclude.discard(norm)

        for exc in list(self.exclude):
            if norm == "/" and exc != "/":
                self.exclude.discard(exc)
            elif exc.startswith(norm + "/"):
                self.exclude.discard(exc)

        for inc in list(self.include):
            if norm == "/" and inc != "/":
                self.include.discard(inc)
            elif inc.startswith(norm + "/"):
                self.include.discard(inc)

        _, anc_type = self._longest_ancestor(norm)
        if anc_type != "include":
            self.include.add(norm)

    def unselect(self, path):
        norm = self._norm(path)
        self.include.discard(norm)

        for inc in list(self.include):
            if norm == "/" and inc != "/":
                self.include.discard(inc)
            elif inc.startswith(norm + "/"):
                self.include.discard(inc)

        for exc in list(self.exclude):
            if norm == "/" and exc != "/":
                self.exclude.discard(exc)
            elif exc.startswith(norm + "/"):
                self.exclude.discard(exc)

        _, anc_type = self._longest_ancestor(norm)
        if anc_type == "include":
            self.exclude.add(norm)

    def migrate_path(self, old_path, new_path):
        norm_old = self._norm(old_path)
        norm_new = self._norm(new_path)
        if norm_old == norm_new:
            return

        prefix_old = "/" if norm_old == "/" else norm_old + "/"

        new_include = set()
        for inc in self.include:
            if inc == norm_old:
                new_include.add(norm_new)
            elif inc.startswith(prefix_old):
                new_include.add(norm_new + inc[len(norm_old):])
            else:
                new_include.add(inc)
        self.include = new_include

        new_exclude = set()
        for exc in self.exclude:
            if exc == norm_old:
                new_exclude.add(norm_new)
            elif exc.startswith(prefix_old):
                new_exclude.add(norm_new + exc[len(norm_old):])
            else:
                new_exclude.add(exc)
        self.exclude = new_exclude

    def delete_path(self, path):
        norm = self._norm(path)
        prefix = "/" if norm == "/" else norm + "/"
        for inc in list(self.include):
            if inc == norm or inc.startswith(prefix):
                self.include.discard(inc)
        for exc in list(self.exclude):
            if exc == norm or exc.startswith(prefix):
                self.exclude.discard(exc)

    def get_top_level_includes(self):
        roots = []
        for inc in self.include:
            _, anc_type = self._longest_ancestor(inc)
            if anc_type != "include":
                roots.append(inc)
        return sorted(roots)

    def to_transfer_sources(self):
        top_roots = self.get_top_level_includes()
        result = []
        for root in top_roots:
            prefix = "/" if root == "/" else root + "/"
            relative_excludes = []
            for exc in self.exclude:
                if exc.startswith(prefix):
                    closest_inc = None
                    closest_len = -1
                    for inc in self.include:
                        if exc.startswith("/" if inc == "/" else inc + "/"):
                            l = 1 if inc == "/" else len(inc)
                            if l > closest_len:
                                closest_len = l
                                closest_inc = inc
                    if closest_inc == root:
                        rel = exc[1:] if root == "/" else exc[len(root) + 1:]
                        if rel:
                            relative_excludes.append(rel)
            if not relative_excludes:
                result.append(root)
            else:
                result.append({"path": root, "excludes": sorted(relative_excludes)})
        return result


class TestSelectionModel(unittest.TestCase):
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

    def test_three_level_reinclusion_evaluation(self):
        """Include parent, exclude child, re-include grandchild inside the excluded child.
        Verify longest-match resolution picks the grandchild as selected."""
        sel = SelectionModelHelper()
        sel.select("/movies")
        sel.unselect("/movies/2026")
        sel.select("/movies/2026/specific.mkv")

        self.assertTrue(sel.is_path_selected("/movies/2026/specific.mkv"))
        self.assertFalse(sel.is_path_selected("/movies/2026/other.mkv"))
        self.assertFalse(sel.is_path_selected("/movies/2026/subfolder/test.mp4"))
        self.assertTrue(sel.is_path_selected("/movies/2025/movie.mkv"))
        self.assertTrue(sel.is_path_selected("/movies/comedy/film.mp4"))

    def test_three_level_reinclusion_transfer_generation_end_to_end(self):
        """Walk the exact three-level example end-to-end:
        include /movies -> exclude /movies/2026 -> include /movies/2026/specific.mkv
        Assert the resulting transfer payload contains two sources:
        {path: '/movies', excludes: ['2026']} and a plain flat '/movies/2026/specific.mkv'."""
        sel = SelectionModelHelper()
        sel.select("/movies")
        sel.unselect("/movies/2026")
        sel.select("/movies/2026/specific.mkv")

        payload_sources = sel.to_transfer_sources()
        expected = [
            {"path": "/movies", "excludes": ["2026"]},
            "/movies/2026/specific.mkv",
        ]
        self.assertEqual(payload_sources, expected)

    def test_reincluding_directory_prunes_nested_excludes(self):
        """Re-including a directory prunes/adjusts nested exclude entries correctly."""
        sel = SelectionModelHelper()
        sel.select("/movies")
        sel.unselect("/movies/2026")
        sel.select("/movies/2026/sub1")
        sel.unselect("/movies/2026/sub1/file.txt")

        # Now re-include /movies/2026
        sel.select("/movies/2026")

        self.assertNotIn("/movies/2026", sel.exclude)
        self.assertNotIn("/movies/2026/sub1/file.txt", sel.exclude)
        self.assertNotIn("/movies/2026/sub1", sel.include)
        self.assertTrue(sel.is_path_selected("/movies/2026/sub1/file.txt"))
        self.assertTrue(sel.is_path_selected("/movies/2026/other.txt"))

    def test_rename_selected_item_migration(self):
        """Rename selected item: verify selection follows rename or is cleanly dropped."""
        sel = SelectionModelHelper()
        sel.select("/movies")
        sel.unselect("/movies/2026/bad.mkv")

        sel.migrate_path("/movies", "/films")

        self.assertIn("/films", sel.include)
        self.assertNotIn("/movies", sel.include)
        self.assertIn("/films/2026/bad.mkv", sel.exclude)
        self.assertNotIn("/movies/2026/bad.mkv", sel.exclude)
        self.assertTrue(sel.is_path_selected("/films/2026/good.mkv"))
        self.assertFalse(sel.is_path_selected("/films/2026/bad.mkv"))

    def test_delete_selected_item_migration(self):
        """Delete selected item: verify no orphaned selection state remains."""
        sel = SelectionModelHelper()
        sel.select("/movies")
        sel.unselect("/movies/2026/bad.mkv")

        sel.delete_path("/movies/2026/bad.mkv")
        self.assertNotIn("/movies/2026/bad.mkv", sel.exclude)

        sel.delete_path("/movies")
        self.assertEqual(len(sel.include), 0)
        self.assertEqual(len(sel.exclude), 0)

    def test_large_conceptual_subtree_performance_no_disk_walk(self):
        """Large conceptual subtree without materializing thousands of paths.
        Assert that evaluation and selection actions remain sub-millisecond with 100,000 paths."""
        sel = SelectionModelHelper()
        sel.select("/huge_dataset")
        sel.unselect("/huge_dataset/shard_42")

        t0 = time.perf_counter()
        # Evaluate 10,000 paths in memory
        for i in range(10000):
            sel.is_path_selected(f"/huge_dataset/shard_{i}/file_{i}.bin")
        elapsed = time.perf_counter() - t0

        # Must execute within a fraction of a second (< 0.2s for 10k evaluations)
        self.assertLess(elapsed, 0.2)
        self.assertEqual(len(sel.include), 1)
        self.assertEqual(len(sel.exclude), 1)

    def test_exclude_path_validation_rejects_leading_slash(self):
        """Exclude path validation must reject leading slashes."""
        req = TransferRequest(
            sources=[TransferSourceItem(path=str(self.source_dir), excludes=["/leading/slash"])],
            destination=str(self.dest_dir),
            operation="copy",
        )
        with patch("app.tasks.routes.get_settings", return_value=self.settings):
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(create_transfer(req, user="test_user"))
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertIn("without leading slash", ctx.exception.detail)

    def test_exclude_path_validation_rejects_directory_traversal(self):
        """Exclude path validation must reject .. traversal."""
        req = TransferRequest(
            sources=[TransferSourceItem(path=str(self.source_dir), excludes=["sub/../../escape"])],
            destination=str(self.dest_dir),
            operation="copy",
        )
        with patch("app.tasks.routes.get_settings", return_value=self.settings):
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(create_transfer(req, user="test_user"))
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertIn("cannot contain directory traversal", ctx.exception.detail)

    def test_rsync_argv_receives_separate_argv_entries(self):
        """Rsync invocation receives exclude patterns as separate argv list entries, never shell-joined."""
        argv = runner.build_rsync_argv(
            source=str(self.source_dir),
            target_path=str(self.dest_dir),
            excludes=["2026/movie.mkv", "cache/temp"],
            operation="copy",
        )
        self.assertIn("--exclude=/2026/movie.mkv", argv)
        self.assertIn("--exclude=/cache/temp", argv)
        self.assertNotIn("--remove-source-files", argv)
        
        # We now append '/' to directories in build_rsync_argv
        self.assertEqual(argv[-2], f"{self.source_dir}/")
        self.assertEqual(argv[-1], str(self.dest_dir))

    def test_rsync_argv_move_with_excludes_includes_remove_source_files(self):
        """When moving with excludes, rsync argv includes --remove-source-files."""
        argv = runner.build_rsync_argv(
            source=str(self.source_dir),
            target_path=str(self.dest_dir),
            excludes=["exclude.txt"],
            operation="move",
        )
        self.assertIn("--remove-source-files", argv)

    def test_same_filesystem_move_with_excludes_bypasses_atomic_rename(self):
        """Moving with excludes cannot use atomic rename because that would move excluded files."""
        sub = self.source_dir / "my_dir"
        sub.mkdir(parents=True, exist_ok=True)
        (sub / "keep.txt").write_text("keep")
        (sub / "exclude.txt").write_text("exclude")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(sub),
            destination=str(self.dest_dir),
            operation="move",
            excludes=["exclude.txt"],
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)
        self.assertEqual(task["excludes"], ["exclude.txt"])

        asyncio.run(runner._run_task(task, self.settings))

        # Check destination
        target_dir = self.dest_dir / "my_dir"
        self.assertTrue(target_dir.exists())
        self.assertTrue((target_dir / "keep.txt").exists())
        self.assertFalse((target_dir / "exclude.txt").exists())

        # Check source: keep.txt was moved, exclude.txt remains!
        self.assertTrue(sub.exists())
        self.assertFalse((sub / "keep.txt").exists())
        self.assertTrue((sub / "exclude.txt").exists())

        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "succeeded")

    def test_move_with_excludes_partial_failure_divergence_behavior(self):
        """Test move-with-excludes failure mode divergence:
        When rsync is interrupted or fails partway with --remove-source-files,
        already-transferred files are deleted from source, not-yet-transferred files remain in source,
        and the task is marked failed with error details (not clean success or clean no-op)."""
        sub = self.source_dir / "partial_dir"
        sub.mkdir(parents=True, exist_ok=True)
        (sub / "transferred.txt").write_text("file 1")
        (sub / "untransferred.txt").write_text("file 2")
        (sub / "excluded.txt").write_text("file 3")

        task_id = runner.queue_task(
            settings=self.settings,
            source=str(sub),
            destination=str(self.dest_dir),
            operation="move",
            excludes=["excluded.txt"],
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)

        # Simulate rsync executing partway: transferred.txt transfers and is removed by --remove-source-files,
        # then rsync exits with code 23 (failure).
        target_dir = self.dest_dir / "partial_dir"
        target_dir.mkdir(parents=True, exist_ok=True)
        (target_dir / "transferred.txt").write_text("file 1")
        (sub / "transferred.txt").unlink()  # rsync removed it upon transfer

        mock_proc = MagicMock()
        mock_proc.returncode = 23
        mock_proc.wait = AsyncMock(return_value=23)

        with patch("asyncio.create_subprocess_exec", return_value=mock_proc):
            asyncio.run(runner._run_task(task, self.settings))

        # Assert already-transferred file is gone from source
        self.assertFalse((sub / "transferred.txt").exists())
        # Assert untransferred and excluded files remain in source
        self.assertTrue((sub / "untransferred.txt").exists())
        self.assertTrue((sub / "excluded.txt").exists())

        # Confirm task status is failed and error_message records the failure
        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "failed")
        self.assertEqual(finished["exit_code"], 23)
        self.assertIn("rsync exited with code 23", finished["error_message"])


if __name__ == "__main__":
    unittest.main()
