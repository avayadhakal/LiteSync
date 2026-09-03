import os
import shutil
import time
from pathlib import Path

_current_kernel_task_id: str | None = None
_kernel_cancel_flag: bool = False

def set_kernel_task_id(task_id: str | None) -> None:
    global _current_kernel_task_id, _kernel_cancel_flag
    _current_kernel_task_id = task_id
    _kernel_cancel_flag = False

def cancel_kernel_task(task_id: str) -> bool:
    global _current_kernel_task_id, _kernel_cancel_flag
    if _current_kernel_task_id == task_id:
        _kernel_cancel_flag = True
        return True
    return False

def _format_speed(bytes_per_sec: float) -> str:
    if bytes_per_sec >= 1024 * 1024:
        return f"{bytes_per_sec / (1024 * 1024):.2f}MB/s"
    elif bytes_per_sec >= 1024:
        return f"{bytes_per_sec / 1024:.2f}kB/s"
    else:
        return f"{bytes_per_sec:.0f}B/s"

def _sync_kernel_copy_worker(src_str: str, target_path_str: str, log_fh, overwrite: bool = False) -> None:
    """Synchronous worker to perform kernel copy (falling back to chunked read/write)."""
    global _kernel_cancel_flag
    src_p = Path(src_str)
    target_path = Path(target_path_str)

    def copy_func(src_file, dst_file):
        if _kernel_cancel_flag:
            raise InterruptedError("Transfer cancelled by user")
        
        src_path = Path(src_file)
        dst_path = Path(dst_file)
        
        # Guard against overwrite
        if dst_path.exists():
            if not overwrite:
                return
            else:
                try:
                    dst_path.unlink()
                except OSError:
                    pass
            
        start_time = time.monotonic()
        last_log_time = start_time
        last_logged_copied = 0

        try:
            # Attempt kernel copy
            if hasattr(os, 'copy_file_range'):
                src_fd = os.open(src_path, os.O_RDONLY)
                try:
                    # preserve mode if possible
                    mode = src_path.stat().st_mode
                    dst_fd = os.open(dst_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
                    try:
                        src_size = src_path.stat().st_size
                        copied = 0
                        last_pct = -1
                        while copied < src_size:
                            if _kernel_cancel_flag:
                                raise InterruptedError("Transfer cancelled by user")
                            # Max 32MB per syscall to ensure we can stream progress
                            n = os.copy_file_range(src_fd, dst_fd, min(src_size - copied, 32 * 1024 * 1024), offset_src=copied, offset_dst=copied)
                            if n == 0:
                                break
                            copied += n
                            
                            if src_size > 0:
                                pct = int((copied / src_size) * 100)
                                now = time.monotonic()
                                if pct != last_pct or (now - last_log_time >= 0.2):
                                    last_pct = pct
                                    dt = max(0.001, now - last_log_time)
                                    speed = (copied - last_logged_copied) / dt
                                    last_log_time = now
                                    last_logged_copied = copied
                                    speed_str = _format_speed(speed)
                                    try:
                                        log_fh.write(f" {copied}/{src_size} {pct}% {speed_str}\n".encode("utf-8"))
                                        log_fh.flush()
                                    except OSError:
                                        pass
                        return
                    finally:
                        os.close(dst_fd)
                finally:
                    os.close(src_fd)
        except OSError:
            pass

        # Fallback to chunked read/write
        chunk_size = 1024 * 1024
        try:
            src_size = src_path.stat().st_size
        except OSError:
            src_size = 0
        copied = 0
        last_pct = -1
        last_log_time = time.monotonic()
        last_logged_copied = 0
        with open(src_path, "rb") as in_f:
            with open(dst_path, "wb") as out_f:
                while True:
                    if _kernel_cancel_flag:
                        raise InterruptedError("Transfer cancelled by user")
                    chunk = in_f.read(chunk_size)
                    if not chunk:
                        break
                    out_f.write(chunk)
                    copied += len(chunk)
                    
                    if src_size > 0:
                        pct = int((copied / src_size) * 100)
                        now = time.monotonic()
                        if pct != last_pct or (now - last_log_time >= 0.2):
                            last_pct = pct
                            dt = max(0.001, now - last_log_time)
                            speed = (copied - last_logged_copied) / dt
                            last_log_time = now
                            last_logged_copied = copied
                            speed_str = _format_speed(speed)
                            try:
                                log_fh.write(f" {copied}/{src_size} {pct}% {speed_str}\n".encode("utf-8"))
                                log_fh.flush()
                            except OSError:
                                pass

    if src_p.is_dir():
        shutil.copytree(src_p, target_path, copy_function=copy_func, dirs_exist_ok=True)
    else:
        copy_func(src_p, target_path)
        
    try:
        log_fh.write(f"{src_p.name}\n".encode("utf-8"))
        log_fh.write(b"            100%    0.00kB/s    0:00:00 (xfr, to-chk=0/1)\n")
        log_fh.flush()
    except OSError:
        pass
