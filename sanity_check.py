import asyncio
from pathlib import Path
from app.tasks.runner import _run_task, build_rsync_argv
from app.config import Settings
from app.tasks import db
import tempfile
import shutil
import os

async def main():
    with tempfile.TemporaryDirectory() as tmp:
        tmp_path = Path(tmp)
        src = tmp_path / "src_dir"
        src.mkdir()
        (src / "file1.txt").write_text("hello")
        
        dest = tmp_path / "dest_dir"
        dest.mkdir()
        (dest / "src_dir").mkdir()
        (dest / "src_dir" / "old_file.txt").write_text("old")
        
        db.init_db(tmp_path)
        
        task_id = "sanity1"
        db.insert_task(
            id=task_id,
            source=str(src),
            destination=str(dest),
            operation="copy",
            use_rsync=True,
            on_conflict="skip"
        )
        task = db.get_task(task_id)
        
        db.mark_running(task_id)
        settings = Settings(
            allowed_roots=[tmp_path], 
            secret_key="test", 
            data_dir=tmp_path,
            users=[],
            session_max_age=60,
            secure_cookie=False,
            host="127.0.0.1",
            port=8000,
            download_expiry=60,
            download_secret_key="key",
            max_upload_size_mb=100
        )
        
        print("Running rsync transfer...")
        await _run_task(task, settings)
        
        print("Destination tree:")
        for root, dirs, files in sorted(os.walk(dest)):
            for d in sorted(dirs):
                print(f" DIR  {os.path.relpath(os.path.join(root, d), dest)}")
            for f in sorted(files):
                print(f" FILE {os.path.relpath(os.path.join(root, f), dest)}")

asyncio.run(main())
