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
    id            TEXT PRIMARY KEY,
    source        TEXT NOT NULL,
    destination   TEXT NOT NULL,
    operation     TEXT NOT NULL,
    status        TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    started_at    TEXT,
    ended_at      TEXT,
    exit_code     INTEGER,
    error_message TEXT,
    excludes      TEXT DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);

CREATE TABLE IF NOT EXISTS activity (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at DESC);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_task_log_path(task_id: str, data_dir: Path | None = None) -> Path:
    """Derive deterministic task log path from task ID without storing it in DB."""
    if data_dir is None:
        if _db_path is not None:
            data_dir = _db_path.parent
        else:
            data_dir = Path("data")

    return data_dir / "tasks" / f"{task_id}.log"


def _row_to_dict(row: sqlite3.Row | None) -> dict | None:
    """Convert SQLite Row to dictionary with authoritative fields."""
    if row is None:
        return None
    d = dict(row)
    task_id = d["id"]
    d["task_id"] = task_id
    raw_exc = d.get("excludes")
    if isinstance(raw_exc, str):
        try:
            d["excludes"] = json.loads(raw_exc)
        except Exception:
            d["excludes"] = []
    elif isinstance(raw_exc, list):
        d["excludes"] = raw_exc
    else:
        d["excludes"] = []
    return d


from contextlib import contextmanager


@contextmanager
def _connect():
    assert _db_path is not None, "init_db() must be called before use"
    conn = sqlite3.connect(_db_path)
    conn.row_factory = sqlite3.Row
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def _migrate_if_needed(conn: sqlite3.Connection) -> None:
    """Safely and idempotently migrate existing tasks table to target schema."""
    cursor = conn.cursor()
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'")
    if not cursor.fetchone():
        # Table does not exist yet; schema creation will create it
        return

    cursor.execute("PRAGMA table_info(tasks)")
    columns = {row["name"] for row in cursor.fetchall()}

    # If already using target schema (has 'source' and 'operation', does not have 'sources')
    if "source" in columns and "operation" in columns and "sources" not in columns:
        if "excludes" not in columns:
            cursor.execute("ALTER TABLE tasks ADD COLUMN excludes TEXT DEFAULT '[]'")
        return

    # Old schema detected, perform migration
    cursor.execute("SELECT * FROM tasks ORDER BY created_at ASC")
    old_rows = cursor.fetchall()

    migrated_tasks: list[dict] = []
    for old_row in old_rows:
        row_dict = dict(old_row)
        task_id = row_dict.get("task_id") or row_dict.get("id") or ""

        # Parse sources
        raw_sources = row_dict.get("sources")
        sources_list: list[str] = []
        if isinstance(raw_sources, str):
            try:
                parsed = json.loads(raw_sources)
                if isinstance(parsed, list):
                    sources_list = [str(s) for s in parsed]
                else:
                    sources_list = [str(parsed)]
            except Exception:
                sources_list = [raw_sources]
        elif isinstance(raw_sources, list):
            sources_list = [str(s) for s in raw_sources]
        elif "source" in row_dict and row_dict["source"]:
            sources_list = [str(row_dict["source"])]

        if not sources_list:
            sources_list = [""]

        # Determine operation
        if "operation" in row_dict and row_dict["operation"]:
            operation = str(row_dict["operation"])
        elif "delete_source" in row_dict:
            operation = "move" if bool(row_dict["delete_source"]) else "copy"
        else:
            operation = "copy"

        destination = str(row_dict.get("destination", ""))
        status = str(row_dict.get("status", "queued"))
        created_at = str(row_dict.get("created_at", now_iso()))
        started_at = row_dict.get("started_at")
        ended_at = row_dict.get("ended_at")
        exit_code = row_dict.get("exit_code")
        error_message = row_dict.get("error_message")

        # Split multi-source tasks deterministically
        for i, src in enumerate(sources_list):
            item_id = task_id if i == 0 else f"{task_id}_{i}"
            migrated_tasks.append({
                "id": item_id,
                "source": src,
                "destination": destination,
                "operation": operation,
                "status": status,
                "created_at": created_at,
                "started_at": started_at,
                "ended_at": ended_at,
                "exit_code": exit_code,
                "error_message": error_message,
            })

    # Recreate table with target schema
    cursor.execute("ALTER TABLE tasks RENAME TO tasks_legacy_backup")
    cursor.execute("""
        CREATE TABLE tasks (
            id            TEXT PRIMARY KEY,
            source        TEXT NOT NULL,
            destination   TEXT NOT NULL,
            operation     TEXT NOT NULL,
            status        TEXT NOT NULL,
            created_at    TEXT NOT NULL,
            started_at    TEXT,
            ended_at      TEXT,
            exit_code     INTEGER,
            error_message TEXT
        );
    """)

    for t in migrated_tasks:
        cursor.execute(
            """
            INSERT INTO tasks
                (id, source, destination, operation, status,
                 created_at, started_at, ended_at, exit_code, error_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                t["id"],
                t["source"],
                t["destination"],
                t["operation"],
                t["status"],
                t["created_at"],
                t["started_at"],
                t["ended_at"],
                t["exit_code"],
                t["error_message"],
            ),
        )

    cursor.execute("DROP TABLE tasks_legacy_backup")


def init_db(data_dir: Path) -> None:
    global _db_path
    data_dir.mkdir(parents=True, exist_ok=True)
    _db_path = data_dir / "litesync.db"
    with _lock, _connect() as conn:
        _migrate_if_needed(conn)
        conn.executescript(SCHEMA)


def insert_task(
    id: str | None = None,
    source: str = "",
    destination: str = "",
    operation: str = "copy",
    status: str = "queued",
    created_at: str | None = None,
    started_at: str | None = None,
    ended_at: str | None = None,
    exit_code: int | None = None,
    error_message: str | None = None,
    excludes: list[str] | None = None,
    **kwargs,
) -> None:
    """Insert a single task into the database."""
    task_id = id or kwargs.get("task_id")
    if not task_id:
        raise ValueError("Task ID is required")

    if not source and "sources" in kwargs and kwargs["sources"]:
        source = kwargs["sources"][0]

    exc_list = excludes if excludes is not None else kwargs.get("excludes", [])
    exc_json = json.dumps(exc_list) if isinstance(exc_list, list) else (str(exc_list) if exc_list else "[]")

    ts = created_at or now_iso()
    with _lock, _connect() as conn:
        conn.execute(
            """
            INSERT INTO tasks
                (id, source, destination, operation, status,
                 created_at, started_at, ended_at, exit_code, error_message, excludes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                task_id,
                source,
                destination,
                operation,
                status,
                ts,
                started_at,
                ended_at,
                exit_code,
                error_message,
                exc_json,
            ),
        )


def mark_running(task_id: str) -> None:
    with _lock, _connect() as conn:
        conn.execute(
            "UPDATE tasks SET status='running', started_at=? WHERE id=?",
            (now_iso(), task_id),
        )


def mark_finished(task_id: str, status: str, exit_code: int | None, error_message: str | None = None) -> None:
    with _lock, _connect() as conn:
        row = conn.execute(
            "SELECT source, destination, operation, status FROM tasks WHERE id=?",
            (task_id,),
        ).fetchone()

        prev_status = row["status"] if row else None

        conn.execute(
            """
            UPDATE tasks
            SET status=?, exit_code=?, error_message=?, ended_at=?
            WHERE id=?
            """,
            (status, exit_code, error_message, now_iso(), task_id),
        )

        # Automatically record terminal transfer activity once
        if row and status in ("succeeded", "failed", "interrupted") and prev_status not in ("succeeded", "failed", "interrupted"):
            src_str = str(row["source"])
            dst_str = str(row["destination"])
            src_name = Path(src_str).name or src_str
            dst_name = Path(dst_str).name or dst_str
            op = str(row["operation"])

            if status == "succeeded":
                summary = f"{src_name} → {dst_name} [source deleted]" if op == "move" else f"{src_name} → {dst_name}"
            elif status == "failed":
                summary = error_message or f"rsync exited with code {exit_code}"
            else:
                summary = error_message or "cancelled by user"

            msg_data = {
                "operation": op,
                "status": status,
                "source": src_str,
                "destination": dst_str,
                "name": src_name,
                "summary": summary,
                "exit_code": exit_code,
                "error": error_message,
            }

            conn.execute(
                "INSERT INTO activity (kind, message, created_at) VALUES (?, ?, ?)",
                ("transfer", json.dumps(msg_data), now_iso()),
            )

            # Auto-prune activity log table to keep newest 500 entries
            conn.execute(
                """
                DELETE FROM activity
                WHERE id NOT IN (
                    SELECT id FROM activity
                    ORDER BY created_at DESC, id DESC
                    LIMIT 500
                )
                """
            )


def get_task(task_id: str) -> dict | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
    return _row_to_dict(row) if row else None


def list_tasks(limit: int = 50, offset: int = 0) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM tasks ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return [_row_to_dict(r) for r in rows if r is not None]


def list_queued_tasks() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM tasks WHERE status='queued' ORDER BY created_at ASC"
        ).fetchall()
    return [_row_to_dict(r) for r in rows if r is not None]


def next_queued_task() -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM tasks WHERE status='queued' ORDER BY created_at ASC LIMIT 1"
        ).fetchone()
    return _row_to_dict(row) if row else None


def list_running_tasks() -> list[dict]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM tasks WHERE status IN ('queued', 'running')").fetchall()
    return [_row_to_dict(r) for r in rows if r is not None]


def delete_task(task_id: str) -> None:
    with _lock, _connect() as conn:
        conn.execute("DELETE FROM tasks WHERE id=?", (task_id,))


# --- Persistent Activity Log helpers ---

def add_activity(
    kind: str,
    message: str | dict,
    created_at: str | None = None,
    max_entries: int = 500,
) -> int:
    """Insert an entry into the activity log table and optionally prune oldest entries."""
    ts = created_at or now_iso()
    msg_str = json.dumps(message) if isinstance(message, dict) else str(message)
    with _lock, _connect() as conn:
        cursor = conn.execute(
            "INSERT INTO activity (kind, message, created_at) VALUES (?, ?, ?)",
            (kind, msg_str, ts),
        )
        inserted_id = cursor.lastrowid or 0
        if max_entries > 0:
            conn.execute(
                """
                DELETE FROM activity
                WHERE id NOT IN (
                    SELECT id FROM activity
                    ORDER BY created_at DESC, id DESC
                    LIMIT ?
                )
                """,
                (max_entries,),
            )
        return inserted_id


def list_activity(limit: int = 100, offset: int = 0) -> list[dict]:
    """Return activity log entries ordered newest first."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, kind, message, created_at FROM activity ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return [dict(r) for r in rows]


def clear_activity() -> None:
    """Delete all records from the activity table."""
    with _lock, _connect() as conn:
        conn.execute("DELETE FROM activity")


def prune_activity(keep_limit: int = 500) -> int:
    """Keep the newest keep_limit activity entries and delete older ones. Returns number of rows deleted."""
    with _lock, _connect() as conn:
        cursor = conn.execute(
            """
            DELETE FROM activity
            WHERE id NOT IN (
                SELECT id FROM activity
                ORDER BY created_at DESC, id DESC
                LIMIT ?
            )
            """,
            (keep_limit,),
        )
        return cursor.rowcount

