from __future__ import annotations

import asyncio
import os
import shutil
import uuid
from pathlib import Path

from app.config import Settings
from app.tasks import db

# --- In-process scheduler state (event-loop owned) ---------------------------
# At most ONE transfer is ever running; everything else waits as 'queued' rows
# in SQLite. Transfers are managed in-process, so closing the browser / dropping
# the SSE stream never interrupts them.
_current_proc: asyncio.subprocess.Process | None = None
_current_task_id: str | None = None
_wake = asyncio.Event()


def build_rsync_argv(
    source: str,
    destination: str,
    excludes: list[str] | None = None,
    operation: str = "copy",
) -> list[str]:
    """Construct rsync arguments without shell wrapping.
    Always includes --ignore-existing to guard against silently overwriting destination files."""
    argv = [
        "rsync",
        "-avh",
        "--progress",
        "--partial",
        "--inplace",
        "--ignore-existing",
    ]
    if operation == "move" and excludes:
        argv.append("--remove-source-files")

    if excludes:
        src_name = Path(source).name
        for exc in excludes:
            exc_clean = exc.strip()
            if exc_clean:
                # Anchored exclude relative to the transferred source directory
                # Passed as separate argv list entries, never string-interpolated or shell-joined
                argv.append(f"--exclude=/{src_name}/{exc_clean}")

    argv.extend([source, destination])
    return argv


def queue_task(
    settings: Settings,
    source: str,
    destination: str,
    operation: str = "copy",
    created_by: str = "",
    excludes: list[str] | None = None,
) -> str:
    """Persist a single-source task as 'queued'. Nothing is launched here —
    the background scheduler independently picks queued rows up."""
    task_id = uuid.uuid4().hex
    db.insert_task(
        id=task_id,
        source=source,
        destination=destination,
        operation=operation,
        excludes=excludes or [],
    )
    return task_id


def wake_scheduler() -> None:
    """Best-effort nudge so newly queued work starts without a poll delay."""
    _wake.set()


def terminate_task(task_id: str) -> bool:
    """Send SIGTERM to the active rsync child of the given running task.

    Returns True if a live process was found. The scheduler watchdog
    escalates to SIGKILL if the child ignores SIGTERM.
    """
    global _current_proc, _current_task_id
    proc = _current_proc
    if _current_task_id == task_id and proc is not None and proc.returncode is None:
        proc.terminate()
        return True
    return False


def _can_atomic_rename(source: str, destination: str) -> bool:
    """Check if moving source to destination can be performed safely via atomic rename (os.rename).

    Requirements:
    1. Source must exist.
    2. Destination must exist and be a directory.
    3. Target entry (destination / source.name) must not already exist (guard against overwrite).
    4. Destination must not be inside source (guard against moving dir into itself).
    5. Source and destination must reside on the same filesystem (same st_dev).
    """
    try:
        src_path = Path(source)
        dst_dir = Path(destination)

        if not src_path.exists() and not src_path.is_symlink():
            return False
        if not dst_dir.is_dir():
            return False

        target_path = dst_dir / src_path.name
        if target_path.exists() or target_path.is_symlink():
            return False

        try:
            if src_path.is_dir() and (dst_dir == src_path or dst_dir.resolve().is_relative_to(src_path.resolve())):
                return False
        except Exception:
            return False

        src_stat = src_path.stat(follow_symlinks=False)
        dst_stat = dst_dir.stat()
        return src_stat.st_dev == dst_stat.st_dev
    except OSError:
        return False


def _try_atomic_move(task: dict, log_path: Path) -> bool:
    """Attempt instant same-filesystem move via os.rename.
    Writes deterministic 100% completion log line and populates all lifecycle fields identically to rsync.
    Returns True if successfully renamed, False if unsafe, cross-filesystem, or has exclusions."""
    if task.get("excludes"):
        # Excludes require selective transfer via rsync, cannot atomic move the whole tree
        return False

    source = task["source"]
    destination = task["destination"]
    task_id = task["id"]

    if not _can_atomic_rename(source, destination):
        return False

    src_path = Path(source)
    dst_dir = Path(destination)
    target_path = dst_dir / src_path.name

    try:
        os.rename(src_path, target_path)
    except OSError:
        return False

    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "wb") as log_fh:
            log_fh.write(f"{src_path.name}\n".encode("utf-8"))
            log_fh.write(b"            100%    0.00kB/s    0:00:00 (xfr, to-chk=0/1)\n")
    except OSError:
        pass

    db.mark_finished(task_id, "succeeded", 0, None)
    return True


async def _run_task(task: dict, settings: Settings) -> None:
    """Execute one queued task, stream output to deterministic task log file,
    and finalize the DB row."""
    global _current_proc, _current_task_id

    task_id = task["id"]
    log_path = db.get_task_log_path(task_id, settings.data_dir)

    # Guard against a cancel that landed between mark_running and spawn.
    latest = db.get_task(task_id)
    if latest is None or latest["status"] != "running":
        return

    # Fast path: atomic rename on same filesystem for move operations
    if task["operation"] == "move":
        if _try_atomic_move(task, log_path):
            return

    src_path = Path(task["source"])
    dst_dir = Path(task["destination"])
    target_path = dst_dir / src_path.name

    # Overwrite guard: if target already exists as a file, fail cleanly without overwriting
    if target_path.exists() and target_path.is_file():
        log_path.parent.mkdir(parents=True, exist_ok=True)
        err = f"Destination item already exists: {target_path.name}"
        try:
            with open(log_path, "wb") as log_fh:
                log_fh.write(f"Error: {err}\n".encode("utf-8"))
        except OSError:
            pass
        db.mark_finished(task_id, "failed", 1, err)
        return

    excludes = task.get("excludes", [])
    argv = build_rsync_argv(
        task["source"],
        task["destination"],
        excludes=excludes,
        operation=task["operation"],
    )
    log_path.parent.mkdir(parents=True, exist_ok=True)

    try:
        log_fh = open(log_path, "wb")
    except OSError as e:
        db.mark_finished(task_id, "failed", None, f"Failed to open log file: {e}")
        return

    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=log_fh,
            stderr=asyncio.subprocess.STDOUT,
        )
    except (FileNotFoundError, OSError) as e:
        log_fh.close()
        db.mark_finished(task_id, "failed", None, f"Failed to start rsync: {e}")
        return

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
                    # Cancel was requested (SIGTERM already sent) -> escalate to SIGKILL if not dead
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
    finally:
        log_fh.close()
        _current_proc = None
        _current_task_id = None

    # Finalize only if nobody (e.g. cancel route or shutdown) already finalized it
    latest = db.get_task(task_id)
    if latest is None or latest["status"] != "running":
        return

    code = proc.returncode
    if code == 0:
        if task["operation"] == "move":
            if excludes:
                # With --remove-source-files, individual transferred files are removed.
                # Prune empty directories bottom-up, keeping non-empty dirs with excluded files.
                try:
                    for root, dirs, files in os.walk(str(src_path), topdown=False):
                        if not dirs and not files and root != str(src_path):
                            try:
                                os.rmdir(root)
                            except OSError:
                                pass
                except Exception:
                    pass
            else:
                # Only delete entire source directory/file after rsync exits successfully with exit code 0
                try:
                    if src_path.is_dir() and not src_path.is_symlink():
                        shutil.rmtree(src_path, ignore_errors=True)
                    elif src_path.exists() or src_path.is_symlink():
                        src_path.unlink(missing_ok=True)
                except Exception:
                    pass
        db.mark_finished(task_id, "succeeded", code, None)
    elif code is not None and code < 0:
        db.mark_finished(task_id, "failed", code, f"rsync killed by signal {-code}")
    else:
        db.mark_finished(task_id, "failed", code, f"rsync exited with code {code}")


async def run_scheduler(settings: Settings) -> None:
    """Background worker: promotes the oldest queued task and runs it, one
    transfer at a time, forever."""
    while True:
        try:
            if _current_task_id is None:
                nxt = db.next_queued_task()
                if nxt is not None:
                    db.mark_running(nxt["id"])
                    await _run_task(nxt, settings)
                    continue
            _wake.clear()
            try:
                await asyncio.wait_for(_wake.wait(), timeout=1.0)
            except asyncio.TimeoutError:
                pass
        except asyncio.CancelledError:
            raise
        except Exception:
            # Never let a transient error kill the scheduler loop
            await asyncio.sleep(1.0)


def reconcile_on_startup(settings: Settings) -> None:
    """Startup reconciliation: mark any leftover 'running' tasks as 'interrupted'.
    Queued tasks remain queued and will resume."""
    for task in db.list_running_tasks():
        if task["status"] == "running":
            db.mark_finished(
                task["id"],
                "interrupted",
                None,
                "Server restarted during transfer",
            )


async def shutdown_runner() -> None:
    """Graceful shutdown: terminate active rsync child, wait for termination,
    mark task as interrupted, and exit."""
    global _current_proc, _current_task_id
    proc = _current_proc
    task_id = _current_task_id
    if proc is not None and proc.returncode is None:
        proc.terminate()
        try:
            await asyncio.wait_for(proc.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            try:
                proc.kill()
                await proc.wait()
            except ProcessLookupError:
                pass
        if task_id:
            db.mark_finished(
                task_id,
                "interrupted",
                None,
                "Server shut down during transfer",
            )

