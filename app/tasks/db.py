from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

_lock = threading.Lock()
_db_path: Path | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
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
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_db(data_dir: Path) -> None:
    global _db_path
    data_dir.mkdir(parents=True, exist_ok=True)
    _db_path = data_dir / "litesync.db"
    with _connect() as conn:
        conn.executescript(SCHEMA)


def _connect() -> sqlite3.Connection:
    assert _db_path is not None, "init_db() must be called before use"
    conn = sqlite3.connect(_db_path)
    conn.row_factory = sqlite3.Row
    return conn


def _row_to_dict(row: sqlite3.Row) -> dict:
    d = dict(row)
    d["sources"] = json.loads(d["sources"])
    d["delete_source"] = bool(d["delete_source"])
    return d


def insert_task(
    task_id: str,
    sources: list[str],
    destination: str,
    delete_source: bool,
    created_by: str,
    tmux_session: str,
    log_path: str,
) -> None:
    with _lock, _connect() as conn:
        conn.execute(
            """
            INSERT INTO tasks
                (task_id, status, sources, destination, delete_source,
                 created_by, created_at, tmux_session, log_path)
            VALUES (?, 'queued', ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                json.dumps(sources),
                destination,
                int(delete_source),
                created_by,
                now_iso(),
                tmux_session,
                log_path,
            ),
        )


def mark_running(task_id: str) -> None:
    with _lock, _connect() as conn:
        conn.execute(
            "UPDATE tasks SET status='running', started_at=? WHERE task_id=?",
            (now_iso(), task_id),
        )


def mark_finished(task_id: str, status: str, exit_code: int | None, error_message: str | None = None) -> None:
    with _lock, _connect() as conn:
        conn.execute(
            """
            UPDATE tasks
            SET status=?, exit_code=?, error_message=?, ended_at=?
            WHERE task_id=?
            """,
            (status, exit_code, error_message, now_iso(), task_id),
        )


def get_task(task_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
    return _row_to_dict(row) if row else None


def list_tasks(limit: int = 50, offset: int = 0) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM tasks ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def list_queued_tasks() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM tasks WHERE status='queued' ORDER BY created_at ASC"
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def next_queued_task() -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM tasks WHERE status='queued' ORDER BY created_at ASC LIMIT 1"
        ).fetchone()
    return _row_to_dict(row) if row else None


def list_running_tasks() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM tasks WHERE status IN ('queued', 'running')").fetchall()
    return [_row_to_dict(r) for r in rows]


def delete_task(task_id: str) -> None:
    with _lock, _connect() as conn:
        conn.execute("DELETE FROM tasks WHERE task_id=?", (task_id,))

