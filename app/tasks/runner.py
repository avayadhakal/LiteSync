from __future__ import annotations

import asyncio
import os
import shutil
import signal
import uuid
from pathlib import Path

from app.config import Settings
from app.tasks import db

# --- In-process scheduler state (event-loop owned) ---------------------------
# At most ONE rsync subprocess is ever running; everything else waits as
# 'queued' rows in SQLite. Transfers are children of the uvicorn worker, so
# closing the browser / dropping the SSE stream never interrupts them.
_current_proc: asyncio.subprocess.Process | None = None
_current_task_id: str | None = None
_wake = asyncio.Event()


def build_rsync_argv(sources: list[str], destination: str, delete_source: bool) -> list[str]:
    argv = ["rsync", "-avh", "--progress", "--partial", "--inplace"]
    if delete_source:
        argv.append("--remove-source-files")
    argv.extend(sources)
    argv.append(destination)
    return argv


def queue_task(
    settings: Settings,
    source: str,
    destination: str,
    delete_source: bool,
    created_by: str = "",
) -> str:
    """Persist a single-source task as 'queued'. Nothing is launched here —
    the background scheduler independently picks queued rows up, so the HTTP
    request can close immediately (fire and forget)."""
    task_id = uuid.uuid4().hex
    task_dir = settings.data_dir / "tasks" / task_id
    task_dir.mkdir(parents=True, exist_ok=True)

    operation = "move" if delete_source else "copy"
    db.insert_task(
        id=task_id,
        source=source,
        destination=destination,
        operation=operation,
    )
    return task_id


def wake_scheduler() -> None:
    """Best-effort nudge so newly queued work starts without a poll delay."""
    _wake.set()


def terminate_task(task_id: str) -> bool:
    """Send SIGTERM to the rsync child of the given running task.

    Returns True if a live process was found. The scheduler's watchdog
    escalates to SIGKILL if the child ignores SIGTERM.
    """
    proc = _current_proc
    if _current_task_id == task_id and proc is not None and proc.returncode is None:
        proc.terminate()
        return True
    return False


def _same_filesystem(sources: list[str], destination: str) -> bool:
    """True when every source and the destination live on one filesystem.

    Same st_dev means os.rename() can move the items atomically, so a
    delete-after-copy on a shared filesystem never needs rsync.
    """
    try:
        dst = Path(destination)
        ref = os.stat(dst if dst.exists() else dst.parent).st_dev
        return all(os.stat(src).st_dev == ref for src in sources)
    except OSError:
        return False


def _fast_move(task: dict, log_path: Path) -> bool:
    """Instant same-filesystem move: a pure rename instead of an rsync
    subprocess. Writes an instant 100% completion line to the task log (the
    SSE stream replays the log before ending with the terminal status event)
    and records 'succeeded' immediately.

    Returns False when the move cannot be applied (e.g. the destination
    entry already exists — rsync would merge, shutil.move refuses), so the
    caller falls back to the normal rsync subprocess path.
    """
    task_id = task["task_id"]
    destination = task["destination"]

    try:
        log_fh = open(log_path, "ab")
        try:
            for source in task["sources"]:
                shutil.move(source, destination)
                log_fh.write(f"{Path(source).name}\n".encode())
            log_fh.write(b"            100%    0.00kB/s    0:00:00 (xfr, to-chk=0/1)\n")
        finally:
            log_fh.close()
    except OSError:
        return False

    db.mark_finished(task_id, "succeeded", 0, None)
    return True


def _prune_empty_dirs(source: str) -> None:
    """Delete now-empty directories after delete_source copies.

    Bottom-up, strictly scoped to the selected item itself — equivalent to
    the old `find <src> -depth -type d -empty -delete`, which also removes
    <src> itself if it ends up empty.
    """
    src = Path(source)
    if not src.is_dir():
        return
    for dirpath, _dirnames, _filenames in os.walk(src, topdown=False):
        try:
            if not os.listdir(dirpath):
                os.rmdir(dirpath)
        except OSError:
            pass
    try:
        src.rmdir()
    except OSError:
        pass


async def _run_task(task: dict) -> None:
    """Spawn rsync for one queued task, stream its output to the per-task log
    file, then finalize the DB row."""
    global _current_proc, _current_task_id

    task_id = task["task_id"]
    task_dir = Path(task["log_path"]).parent
    log_path = Path(task["log_path"])
    pid_path = task_dir / "pid"

    # Guard against a cancel that landed between mark_running and spawn.
    latest = db.get_task(task_id)
    if latest is None or latest["status"] != "running":
        return

    # Fast path: a delete-after-copy within a single filesystem is just a
    # rename — do it in-process and record instant success, no rsync spawn.
    if task["delete_source"] and _same_filesystem(task["sources"], task["destination"]):
        if _fast_move(task, log_path):
            return

    argv = build_rsync_argv(
        task["sources"], task["destination"], bool(task["delete_source"])
    )

    log_fh = open(log_path, "wb")
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=log_fh,   # stdout piped straight into the task's log file
            stderr=asyncio.subprocess.STDOUT,
        )
    except (FileNotFoundError, OSError) as e:
        log_fh.close()
        db.mark_finished(task_id, "failed", None, f"Failed to start rsync: {e}")
        return

    pid_path.write_text(str(proc.pid))
    _current_proc = proc
    _current_task_id = task_id
    try:
        while True:
            try:
                await asyncio.wait_for(asyncio.shield(proc.wait()), timeout=5.0)
                break
            except asyncio.TimeoutError:
                if proc.returncode is not None:
                    break
                latest = db.get_task(task_id)
                if latest is None or latest["status"] != "running":
                    # Cancel was requested (SIGTERM already sent) but the
                    # child is ignoring it -> escalate to SIGKILL.
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
                # Otherwise just a long-running transfer: keep waiting.
    finally:
        log_fh.close()
        pid_path.unlink(missing_ok=True)
        _current_proc = None
        _current_task_id = None

    # Finalize only if nobody (e.g. the cancel route) already did.
    latest = db.get_task(task_id)
    if latest is None or latest["status"] != "running":
        return

    code = proc.returncode
    if code == 0:
        db.mark_finished(task_id, "succeeded", code, None)
        if task["delete_source"]:
            for source in task["sources"]:
                try:
                    _prune_empty_dirs(source)
                except Exception:
                    pass
    elif code is not None and code < 0:
        db.mark_finished(task_id, "failed", code, f"rsync killed by signal {-code}")
    else:
        db.mark_finished(task_id, "failed", code, f"rsync exited with code {code}")


async def run_scheduler(settings: Settings) -> None:
    """Background worker: promotes the oldest queued task and runs it, one
    rsync at a time, forever."""
    while True:
        try:
            if _current_task_id is None:
                nxt = db.next_queued_task()
                if nxt is not None:
                    db.mark_running(nxt["task_id"])
                    await _run_task(nxt)
                    continue  # immediately look for more queued work
            _wake.clear()
            try:
                await asyncio.wait_for(_wake.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                pass
        except asyncio.CancelledError:
            raise
        except Exception:
            # Never let a transient error kill the scheduler loop.
            await asyncio.sleep(1.0)


def _pid_is_rsync(pid: int) -> bool:
    """Confirm a recorded PID still belongs to an rsync process (PID-reuse
    guard before we send signals)."""
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            return b"rsync" in f.read()
    except OSError:
        return False


def reconcile_on_startup(settings: Settings) -> None:
    """The server (re)started, so nothing from the previous run can still be
    managed: stale 'running' tasks become 'interrupted' and their orphaned
    rsync children are best-effort SIGTERMed via the recorded PID."""
    for task in db.list_running_tasks():
        if task["status"] != "running":
            continue  # queued tasks simply resume via the scheduler
        pid_path = Path(task["log_path"]).parent / "pid"
        if pid_path.exists():
            try:
                pid = int(pid_path.read_text().strip())
                if _pid_is_rsync(pid):
                    os.kill(pid, signal.SIGTERM)
            except (ValueError, ProcessLookupError, PermissionError, OSError):
                pass
            pid_path.unlink(missing_ok=True)
        db.mark_finished(
            task["task_id"],
            "interrupted",
            None,
            "Server restarted during transfer",
        )
