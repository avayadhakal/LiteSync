import re

with open("app/transfers/scheduler.py", "r") as f:
    content = f.read()

# Replace imports
content = content.replace("from app.tasks import db", "from app.transfers import db")
content = content.replace("from app.fsops import compute_next_available_name", """from app.transfers.conflict import resolve_conflict, ConflictSkipped
from app.transfers import engine_rsync
from app.transfers import engine_kernel""")

# Remove _current_proc, _current_run_token, _paused_procs, _current_kernel_task_id, _kernel_cancel_flag
content = re.sub(r"_current_proc:.*?\n", "", content)
content = re.sub(r"_current_run_token:.*?\n", "", content)
content = re.sub(r"_current_kernel_task_id:.*?\n", "", content)
content = re.sub(r"_kernel_cancel_flag:.*?\n", "", content)
content = re.sub(r"_paused_procs:.*?\n", "", content)

# update pause_task_runner
pause_func = """def pause_task_runner(task_id: str) -> bool:
    global _current_task_id
    if _current_task_id == task_id:
        if engine_rsync.pause_proc(task_id):
            _current_task_id = None
            wake_scheduler()
            return True
    return False"""
content = re.sub(r"def pause_task_runner.*?return False", pause_func, content, flags=re.DOTALL)

# update terminate_paused_task
term_paused = """def terminate_paused_task(task_id: str) -> bool:
    return engine_rsync.terminate_paused_task(task_id)"""
content = re.sub(r"def terminate_paused_task.*?return False", term_paused, content, flags=re.DOTALL)

# remove build_rsync_argv
content = re.sub(r"def build_rsync_argv.*?return argv", "", content, flags=re.DOTALL)

# update terminate_task
term_task = """def terminate_task(task_id: str) -> bool:
    global _current_task_id
    if _current_task_id == task_id:
        if engine_rsync.terminate_current_proc():
            return True
    if engine_kernel.cancel_kernel_task(task_id):
        return True
    return False"""
content = re.sub(r"def terminate_task\(task_id: str\) -> bool:.*?return False", term_task, content, flags=re.DOTALL)

# remove _sync_kernel_copy_worker
content = re.sub(r"def _sync_kernel_copy_worker.*?pass\n\n\n", "", content, flags=re.DOTALL)

# in _run_task, fix global statement
content = content.replace("global _current_proc, _current_task_id, _current_run_token, _current_kernel_task_id, _kernel_cancel_flag", "global _current_task_id")

# Fix _run_task body
run_task_repl = """    # Check for resume
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
                    log_fh.write(f"Error: {e}\\n".encode("utf-8"))
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
        _current_task_id = task_id"""

# I need to match everything from "    # Check for resume" up to "    try:\n        while True:"
start_str = "    # Check for resume"
end_str = "    try:\n        while True:"
idx1 = content.find(start_str)
idx2 = content.find(end_str)
content = content[:idx1] + run_task_repl + "\n" + content[idx2:]

# Now replace the while loop logic for _current_run_token
content = content.replace("if _current_run_token is not my_run_token:", "if not engine_rsync.is_current_run_token(my_run_token):")
content = content.replace("if _current_run_token is my_run_token:", "if engine_rsync.is_current_run_token(my_run_token):")
content = content.replace("            _current_proc = None", "            engine_rsync.set_current_proc(None, None)")
content = content.replace("            _current_task_id = None", "            _current_task_id = None")
content = content.replace("            _current_run_token = None", "")


# shutdown_runner fixes
shutdown_runner_repl = """async def shutdown_runner() -> None:
    \"\"\"Graceful shutdown: terminate active rsync child, wait for termination,
    mark task as interrupted, and exit.\"\"\"
    global _current_task_id
    proc = engine_rsync.get_current_proc()
    task_id = _current_task_id
    
    if engine_kernel._current_kernel_task_id is not None:
        engine_kernel.cancel_kernel_task(engine_kernel._current_kernel_task_id)
        task_id = engine_kernel._current_kernel_task_id
        
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
        )"""
content = re.sub(r"async def shutdown_runner.*", shutdown_runner_repl, content, flags=re.DOTALL)

with open("app/transfers/scheduler.py", "w") as f:
    f.write(content)

