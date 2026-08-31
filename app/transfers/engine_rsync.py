import asyncio
import signal
from pathlib import Path

_current_proc: asyncio.subprocess.Process | None = None
_current_run_token: object | None = None
_paused_procs: dict[str, asyncio.subprocess.Process] = {}

def build_rsync_argv(
    source: str,
    target_path: str,
    excludes: list[str] | None = None,
    operation: str = "copy",
    drop_ignore_existing: bool = False,
) -> list[str]:
    """Construct rsync arguments without shell wrapping.
    Optionally drops --ignore-existing to allow overwriting."""
    argv = [
        "rsync",
        "-avh",
        "--progress",
        "--partial",
        "--inplace",
    ]
    if not drop_ignore_existing:
        argv.append("--ignore-existing")

    if operation == "move" and excludes:
        argv.append("--remove-source-files")

    src_p = Path(source)
    is_dir = src_p.is_dir()

    if excludes:
        for exc in excludes:
            exc_clean = exc.strip()
            if exc_clean:
                if is_dir:
                    argv.append(f"--exclude=/{exc_clean}")
                else:
                    argv.append(f"--exclude=/{exc_clean}")

    if is_dir:
        argv.extend([f"{source}/", target_path])
    else:
        argv.extend([source, target_path])
    return argv

def pause_proc(task_id: str) -> bool:
    global _current_proc, _current_run_token
    if _current_proc is not None and _current_proc.returncode is None:
        try:
            _current_proc.send_signal(signal.SIGSTOP)
        except ProcessLookupError:
            return False
        _paused_procs[task_id] = _current_proc
        _current_proc = None
        _current_run_token = None
        return True
    return False

def terminate_paused_task(task_id: str) -> bool:
    if task_id in _paused_procs:
        proc = _paused_procs.pop(task_id)
        if proc.returncode is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        return True
    return False

def terminate_current_proc() -> bool:
    global _current_proc
    if _current_proc is not None and _current_proc.returncode is None:
        _current_proc.terminate()
        return True
    return False

def has_paused_task(task_id: str) -> bool:
    return task_id in _paused_procs

def pop_paused_task(task_id: str) -> asyncio.subprocess.Process | None:
    return _paused_procs.pop(task_id, None)

def resume_proc(proc: asyncio.subprocess.Process, run_token: object) -> bool:
    global _current_proc, _current_run_token
    try:
        proc.send_signal(signal.SIGCONT)
    except ProcessLookupError:
        return False
    _current_proc = proc
    _current_run_token = run_token
    return True

def set_current_proc(proc: asyncio.subprocess.Process | None, run_token: object | None) -> None:
    global _current_proc, _current_run_token
    _current_proc = proc
    _current_run_token = run_token

def is_current_run_token(token: object) -> bool:
    return _current_run_token is token

def get_all_paused_procs() -> dict[str, asyncio.subprocess.Process]:
    return _paused_procs

def get_current_proc() -> asyncio.subprocess.Process | None:
    return _current_proc
