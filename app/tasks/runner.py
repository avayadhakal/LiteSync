from __future__ import annotations

import asyncio
import shlex
import subprocess
import uuid
from pathlib import Path

from app.config import Settings
from app.tasks import db


def _tmux_base(settings: Settings) -> list[str]:
    return ["tmux", "-L", settings.tmux_socket_name]


def _session_exists(settings: Settings, session: str) -> bool:
    result = subprocess.run(
        [*_tmux_base(settings), "has-session", "-t", session],
        capture_output=True,
    )
    return result.returncode == 0


def _kill_session(settings: Settings, session: str) -> None:
    subprocess.run([*_tmux_base(settings), "kill-session", "-t", session], capture_output=True)


def build_rsync_argv(sources: list[str], destination: str, delete_source: bool) -> list[str]:
    argv = ["rsync", "-avh", "--progress", "--partial", "--inplace"]
    if delete_source:
        argv.append("--remove-source-files")
    argv.extend(sources)
    argv.append(destination)
    return argv


def write_task_script(
    script_path: Path,
    argv: list[str],
    exit_code_path: Path,
    sources: list[str],
    delete_source: bool,
) -> None:
    lines = ["#!/bin/sh"]
    lines.append(" ".join(shlex.quote(a) for a in argv))
    lines.append(f"echo $? > {shlex.quote(str(exit_code_path))}")
    if delete_source:
        # Prune now-empty source subfolders. Scoped to each selected item
        # itself, so this can never prune anything above the selected path.
        for source in sources:
            if Path(source).is_dir():
                lines.append(f"find {shlex.quote(source)} -depth -type d -empty -delete")
    script_path.write_text("\n".join(lines) + "\n")
    script_path.chmod(0o700)


def start_tmux_task(
    settings: Settings,
    sources: list[str],
    destination: str,
    delete_source: bool,
    created_by: str,
) -> str:
    task_id = uuid.uuid4().hex
    session = f"litesync-{task_id}"
    task_dir = settings.data_dir / "tasks" / task_id
    task_dir.mkdir(parents=True, exist_ok=True)

    log_path = task_dir / "log"
    exit_code_path = task_dir / "exit_code"
    script_path = task_dir / "run.sh"

    argv = build_rsync_argv(sources, destination, delete_source)
    write_task_script(script_path, argv, exit_code_path, sources, delete_source)

    db.insert_task(
        task_id=task_id,
        sources=sources,
        destination=destination,
        delete_source=delete_source,
        created_by=created_by,
        tmux_session=session,
        log_path=str(log_path),
    )

    try:
        # Start the pane in a plain, non-login /bin/sh rather than the
        # server user's normal login shell, so no rc-file prompt/shell-
        # integration escape sequences leak into the captured log.
        subprocess.run(
            [
                *_tmux_base(settings),
                "new-session",
                "-d",
                "-s",
                session,
                "-x",
                "220",
                "-y",
                "50",
                "/bin/sh",
            ],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [
                *_tmux_base(settings),
                "pipe-pane",
                "-o",
                "-t",
                f"{session}:0.0",
                f"cat >> {shlex.quote(str(log_path))}",
            ],
            check=True,
            capture_output=True,
        )
        kill_cmd = " ".join(shlex.quote(x) for x in _tmux_base(settings))
        send_cmd = f"sh {shlex.quote(str(script_path))}; {kill_cmd} kill-session -t {shlex.quote(session)}"
        subprocess.run(
            [*_tmux_base(settings), "send-keys", "-t", f"{session}:0.0", send_cmd, "Enter"],
            check=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as e:
        db.mark_finished(task_id, "failed", None, f"Failed to launch tmux task: {e}")
        _kill_session(settings, session)
        return task_id

    db.mark_running(task_id)
    return task_id


def _finalize_from_exit_code(task: dict, exit_code_path: Path) -> None:
    code = int(exit_code_path.read_text().strip())
    status = "succeeded" if code == 0 else "failed"
    error = None if code == 0 else f"rsync exited with code {code}"
    db.mark_finished(task["task_id"], status, code, error)


async def poll_running_tasks(settings: Settings) -> None:
    while True:
        await asyncio.sleep(2)
        try:
            for task in db.list_running_tasks():
                exit_code_path = Path(task["log_path"]).parent / "exit_code"
                if exit_code_path.exists():
                    _finalize_from_exit_code(task, exit_code_path)
                    if _session_exists(settings, task["tmux_session"]):
                        _kill_session(settings, task["tmux_session"])
        except Exception:
            # Never let a transient error kill the background poller.
            pass


def reconcile_on_startup(settings: Settings) -> None:
    for task in db.list_running_tasks():
        session = task["tmux_session"]
        exit_code_path = Path(task["log_path"]).parent / "exit_code"

        if exit_code_path.exists():
            _finalize_from_exit_code(task, exit_code_path)
            if _session_exists(settings, session):
                _kill_session(settings, session)
        elif _session_exists(settings, session):
            if task["status"] == "queued":
                db.mark_running(task["task_id"])
        else:
            db.mark_finished(
                task["task_id"],
                "interrupted",
                None,
                "tmux session lost (server restart or crash)",
            )
