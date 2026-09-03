from __future__ import annotations

import asyncio
import os
import shutil
import uuid
from pathlib import Path

from app.config import Settings
from app.transfers import db
from app.transfers.conflict import resolve_conflict, ConflictSkipped
from app.transfers import engine_rsync
from app.transfers import engine_kernel
from app.transfers import engine_url_download
from app.transfers.engine_url_download import extract_inferred_filename

# --- In-process scheduler state (event-loop owned) ---------------------------
# At most ONE transfer is ever running; everything else waits as 'queued' rows
# in SQLite. Transfers are managed in-process, so closing the browser / dropping
# the SSE stream never interrupts them.
_current_task_id: str | None = None
_wake = asyncio.Event()

def pause_task_runner(task_id: str) -> bool:
    global _current_task_id
    if _current_task_id == task_id:
        if engine_rsync.pause_proc(task_id):
            _current_task_id = None
            wake_scheduler()
            return True
    return False

def terminate_paused_task(task_id: str) -> bool:
    return engine_rsync.terminate_paused_task(task_id)






def queue_task(
    settings: Settings,
    source: str,
    destination: str,
    operation: str = "copy",
    excludes: list[str] | None = None,
    use_rsync: bool = False,
    on_conflict: str = "skip",
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
        use_rsync=use_rsync,
        on_conflict=on_conflict,
    )
    return task_id


def wake_scheduler() -> None:
    """Best-effort nudge so newly queued work starts without a poll delay."""
    _wake.set()


def terminate_task(task_id: str) -> bool:
    global _current_task_id
    if _current_task_id == task_id:
        if engine_rsync.terminate_current_proc():
            return True
    if engine_kernel.cancel_kernel_task(task_id):
        return True
    if engine_url_download.cancel_url_download_task(task_id):
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
    global _current_task_id
    
    my_run_token = object()

    task_id = task["id"]
    log_path = db.get_task_log_path(task_id, settings.data_dir)
    log_path.parent.mkdir(parents=True, exist_ok=True)

    # Guard against a cancel that landed between mark_running and spawn.
    latest = db.get_task(task_id)
    if latest is None or latest["status"] != "running":
        return

    # Check for resume
    if engine_rsync.has_paused_task(task_id):
        proc = engine_rsync.pop_paused_task(task_id)
        if not engine_rsync.resume_proc(proc, my_run_token):
            db.mark_finished(task_id, "interrupted", None, "Process exited while paused")
            return
        
        _current_task_id = task_id
        
        try:
            log_fh = open(log_path, "ab")
        except OSError as e:
            db.mark_finished(task_id, "failed", None, f"Failed to open log file: {e}")
            return
    else:
        if task["operation"] == "url_download":
            url = task["source"]
            dst_path = Path(task["destination"])
            if dst_path.is_dir():
                filename = extract_inferred_filename(url)
                target_path = dst_path / filename
            else:
                target_path = dst_path
            on_conflict = task.get("on_conflict", "skip")

            try:
                resolution = resolve_conflict(target_path, on_conflict, log_path, task_id)
            except ConflictSkipped:
                return

            target_path = resolution.target_path
            log_path.parent.mkdir(parents=True, exist_ok=True)
            try:
                log_fh = open(log_path, "wb")
            except OSError as e:
                db.mark_finished(task_id, "failed", None, f"Failed to open log file: {e}")
                return

            max_bytes = settings.max_upload_size_mb * 1024 * 1024
            engine_url_download.set_url_download_task_id(task_id)
            try:
                await asyncio.to_thread(
                    engine_url_download._sync_url_download_worker,
                    task_id,
                    url,
                    target_path,
                    log_fh,
                    max_size_bytes=max_bytes,
                )
                code = 0
            except InterruptedError:
                db.mark_finished(task_id, "interrupted", None, "Download cancelled by user")
                return
            except Exception as e:
                err_msg = str(e)
                try:
                    log_fh.write(f"Error: {err_msg}\n".encode("utf-8"))
                except OSError:
                    pass
                code = 1
                db.mark_finished(task_id, "failed", code, err_msg)
                return
            finally:
                log_fh.close()
                engine_url_download.set_url_download_task_id(None)

            latest = db.get_task(task_id)
            if latest is None or latest["status"] != "running":
                return

            db.mark_finished(task_id, "succeeded", code, None)
            return

        # Fast path: atomic rename on same filesystem for move operations
        if task["operation"] == "move":
            if _try_atomic_move(task, log_path):
                return

        src_path = Path(task["source"])
        dst_dir = Path(task["destination"])
        target_path = dst_dir / src_path.name

        on_conflict = task.get("on_conflict", "skip")

        try:
            resolution = resolve_conflict(target_path, on_conflict, log_path, task_id)
        except ConflictSkipped:
            return
            
        target_path = resolution.target_path
        drop_ignore = resolution.drop_ignore

        excludes = task.get("excludes", [])
        use_rsync = task.get("use_rsync", False)

        log_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            log_fh = open(log_path, "wb")
        except OSError as e:
            db.mark_finished(task_id, "failed", None, f"Failed to open log file: {e}")
            return

        # Determine if we can use kernel copy
        if not use_rsync and not excludes:
            engine_kernel.set_kernel_task_id(task_id)
            try:
                await asyncio.to_thread(engine_kernel._sync_kernel_copy_worker, task["source"], str(target_path), log_fh, drop_ignore)
                code = 0
            except InterruptedError:
                db.mark_finished(task_id, "interrupted", None, "Transfer cancelled by user")
                return
            except Exception as e:
                try:
                    log_fh.write(f"Error: {e}\n".encode("utf-8"))
                except OSError:
                    pass
                code = 1
            finally:
                log_fh.close()
                engine_kernel.set_kernel_task_id(None)

            latest = db.get_task(task_id)
            if latest is None or latest["status"] != "running":
                return

            if code == 0:
                if task["operation"] == "move":
                    try:
                        if src_path.is_dir() and not src_path.is_symlink():
                            shutil.rmtree(src_path, ignore_errors=True)
                        elif src_path.exists() or src_path.is_symlink():
                            src_path.unlink(missing_ok=True)
                    except Exception:
                        pass
                db.mark_finished(task_id, "succeeded", code, None)
            else:
                db.mark_finished(task_id, "failed", code, "Kernel copy failed")
            return

        argv = engine_rsync.build_rsync_argv(
            task["source"],
            str(target_path),
            excludes=excludes,
            operation=task["operation"],
            drop_ignore_existing=drop_ignore,
        )

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

        engine_rsync.set_current_proc(proc, my_run_token)
        _current_task_id = task_id
    try:
        while True:
            try:
                await asyncio.wait_for(asyncio.shield(proc.wait()), timeout=5.0)
                break
            except asyncio.TimeoutError:
                if proc.returncode is not None:
                    break
                
                # Check if this run loop was detached (e.g. paused)
                if not engine_rsync.is_current_run_token(my_run_token):
                    break
                    
                latest = db.get_task(task_id)
                if latest is None or latest["status"] == "interrupted":
                    # Cancel was requested (SIGTERM already sent) -> escalate to SIGKILL if not dead
                    try:
                        proc.kill()
                    except ProcessLookupError:
                        pass
                elif latest["status"] != "running":
                    # Catch-all for paused, queued, failed, succeeded
                    break
    finally:
        log_fh.close()
        if engine_rsync.is_current_run_token(my_run_token):
            engine_rsync.set_current_proc(None, None)
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
    """Startup reconciliation: mark any leftover 'running' or 'paused' tasks as 'interrupted'.
    Queued tasks remain queued and will resume."""
    for task in db.list_running_tasks():
        if task["status"] in ("running", "paused"):
            db.mark_finished(
                task["id"],
                "interrupted",
                None,
                "Server restarted during transfer",
            )


async def shutdown_runner() -> None:
    """Graceful shutdown: terminate active rsync child, wait for termination,
    mark task as interrupted, and exit."""
    global _current_task_id
    proc = engine_rsync.get_current_proc()
    task_id = _current_task_id
    
    if engine_kernel._current_kernel_task_id is not None:
        engine_kernel.cancel_kernel_task(engine_kernel._current_kernel_task_id)
        task_id = engine_kernel._current_kernel_task_id
    elif engine_url_download._current_url_download_task_id is not None:
        engine_url_download.cancel_url_download_task(engine_url_download._current_url_download_task_id)
        task_id = engine_url_download._current_url_download_task_id
        
    for p_id, p in list(engine_rsync.get_all_paused_procs().items()):
        if p.returncode is None:
            try:
                p.kill()
                await p.wait()
            except ProcessLookupError:
                pass
        db.mark_finished(
            p_id,
            "interrupted",
            None,
            "Server shut down during transfer",
        )
        
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