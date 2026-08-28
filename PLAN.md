# LiteSync — Architecture & Implementation Plan

## 1. System Context & Core Principles
Minimal-overhead Raspberry Pi web app for dual-pane local directory browsing and background `rsync` transfers.
* **Stack**: Python + FastAPI (async, SSE-friendly) on `uvicorn` (`--workers 1`). Vanilla HTML/JS/CSS frontend.
* **Auth**: Built-in lightweight auth (TOML hashed passwords, signed session cookies).
* **Security**: Filesystem constrained to admin-configured "allowed roots". `fsops.resolve_safe_path()` strictly validates all paths against traversal/symlink escapes.
* **Transfer Engine**: Background asyncio subprocess worker. Survives browser closures. Logs pipe directly to per-task files, streamed to UI via SSE.
* **UI Paradigms**: Single-page application (SPA). Independent transfer cards (1 per source). Contextual modals for file mutation. Toast notifications. SQLite persistent activity log.

## 2. Project Structure
```text
/home/homelab/projects/LiteSync/
├── app/
│   ├── __init__.py
│   ├── main.py               # FastAPI app, static mounts, routers, startup poller/reconciliation
│   ├── config.py             # Loads config.toml -> Settings object via tomllib
│   ├── auth.py               # bcrypt password hashing, signed cookies, login/lockout logic
│   ├── fsops.py              # resolve_safe_path(), list_directory() — path validation
│   ├── routes_browse.py      # /api/roots, /api/browse, /api/mkdir | rename | delete, /api/download
│   └── tasks/
│       ├── __init__.py
│       ├── db.py             # sqlite3 wrapper (init, CRUD, next_queued_task, activity log)
│       ├── runner.py         # rsync argv, asyncio subprocess scheduler, SIGTERM, fast-path move
│       └── routes.py         # POST /api/transfer, GET /api/tasks, SSE stream generator, /api/activity
├── static/
│   ├── login.html
│   ├── index.html            # Main SPA shell
│   ├── css/app.css           # Vanilla CSS (custom properties, responsive flex, modals, popovers)
│   └── js/app.js             # Dual-pane logic, SSE Map, Toast/Activity system, Modal handlers
├── data/                     # Gitignored runtime data
│   ├── litesync.db           # SQLite database (tasks + activity tables)
│   └── tasks/<task_id>.log   # Deterministic flat task logs
├── config.example.toml
├── config.toml               # Gitignored (chmod 600)
├── install.sh                # Automated installer & deployment helper
├── uninstall.sh              # Automated service and file uninstaller
├── requirements.txt
├── litesync.service          # systemd unit (NoNewPrivileges=true, ProtectSystem=strict)
└── README.md
```

## 3. Database Schema (SQLite)

`data/litesync.db` guarded by `threading.Lock()`.

```sql
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,          -- uuid4 hex
  source        TEXT NOT NULL,             -- single source path
  destination   TEXT NOT NULL,
  operation     TEXT NOT NULL,             -- 'copy' | 'move'
  status        TEXT NOT NULL,             -- 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted'
  created_at    TEXT NOT NULL,             -- ISO8601
  started_at    TEXT,
  ended_at      TEXT,
  exit_code     INTEGER,
  error_message TEXT,
  excludes      TEXT DEFAULT '[]'
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC);

CREATE TABLE activity (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_activity_created ON activity(created_at DESC);
```

## 4. Backend Engine & API Endpoints

### API Routing

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/api/login` | Authenticates credentials and sets secure session cookie. |
| POST | `/api/logout` | Clears user session cookie. |
| GET | `/api/whoami`, `/api/roots` | Session context & configured root validation. |
| GET | `/api/browse?path=<abs>` | Returns `{path, parent, entries}`. Filters out-of-root symlinks. |
| GET | `/api/download/link?path=<abs>` | Generates signed HMAC download URL. |
| GET/HEAD | `/api/download?path=<abs>` | Single streaming & download endpoint supporting HTTP Range requests. |
| POST | `/api/mkdir` | `{path, name}` → `Path.mkdir()`. Rejects slashes/collisions. |
| POST | `/api/rename` | `{path, new_name}` → `Path.rename()`. Refuses renaming roots. |
| POST | `/api/delete` | `{path}` → `shutil.rmtree()` / `unlink()`. Refuses deleting roots. |
| POST | `/api/transfer` | `{sources: [{path, excludes}], destination, operation}` → Queues 1 task **per source**. |
| GET | `/api/tasks`, `/{id}` | Task history pagination and detail retrieval. |
| GET | `/api/tasks/{id}/stream` | SSE: yields live log tail, closes with `status` event. |
| POST | `/api/tasks/{id}/cancel` | Cancels active transfer or unqueues pending task. |
| DELETE | `/api/tasks/{id}`, `/tasks` | Deletes task history records and log files. |
| GET | `/api/activity` | Retrieves authoritative activity log entries newest first. |
| DELETE | `/api/activity` | Clears activity log table. |

### Transfer Engine (Asyncio Subprocess)

1. **FIFO Scheduler:** `queue_task` inserts DB row → `wake_scheduler()` triggers `asyncio.create_subprocess_exec`. Runs one concurrent task.
2. **Direct Logging:** Process `stdout`/`stderr` piped straight to `data/tasks/<task_id>.log`.
3. **Same-Filesystem Fast Path:** If `os.stat(src).st_dev == dest.st_dev` AND `operation == "move"` without excludes, `runner.py` executes atomic `os.rename()`. Writes instant `100%` summary to log, marks `succeeded`.
4. **Lifecycle & Pruning:** On move with exclusions, rsync runs with `--remove-source-files`, followed by bottom-up empty directory pruning.
5. **Startup Reconciliation:** Stale `running` tasks marked `interrupted` with "Server restarted during transfer". Queued tasks survive and resume automatically.

## 5. Frontend Architecture (Vanilla HTML/CSS/JS)

### Layout & Responsiveness (`app.css` / `app.js`)

* **CSS Variables:** Layout dimensions (`--left-width`, `--top-height`, `--bottom-height`) applied to `:root`. JS `initResizers()` updates CSS vars on drag.
* **Mobile View (`max-width: 768px`):** Panes stack vertically. Pane headers wrap dynamically.
* **Dual-Pane Logic:** Both Source and Dest panes share identical toolbars (`📁+`, `✏️`, `🗑️`). Selections are isolated.

### File Mutation Modals & Toasts

* **Modals:** Reusable styling (`.modal-backdrop`, `.modal`). Dedicated popups for Mkdir, Rename, Delete, Item Details, and Confirmations.
* **Toasts (`.toast-stack`):** Top-right fixed position. Auto-dismiss (4s) or click-to-dismiss. Slide-in animations.
* **Activity Log (SQLite):** Persistent across browsers and reloads. Color-coded by severity. Replaces the legacy localStorage model.

### Active Transfers UI

* **Unbatched Cards:** Multi-item transfers spawn individual `.transfer-card` elements (one per item). Queued items show `Queued...` and can be canceled before execution.
* **Selection Action Bar:** Hidden when count is 0; contains Summary, View, Clear, and Transfer controls.
* **Transfer Confirmation Modal:** Contains operation options (`copy` vs `move`) directly under destination path.
* **Contextual View Popover:** Displays full paths of selected items and exclusions with overflow scrolling.

### File Browser UX & Inspection

* **Full Path Tooltips (Desktop Hover + Mobile Long-Press):**
  * Standard HTML `title` attributes attached to each `.entry` row provide native hover tooltips on desktop for truncated paths.
  * On touch devices, a ~500ms long-press listener displays the `item-details-modal` bottom sheet with full path and Copy URL controls.
* **Copy Download Link to Clipboard (`.btn-copy-path`):**
  * Subtle icon button (`📋`) rendered on file rows (`!entry.is_dir`).
  * Copies a signed download URL directly to the clipboard.
* **Hierarchical Selection Cascading & Pruning (`SelectionModel`):**
  * Recursive selection model supports arbitrary sub-item exclusions and re-inclusions without filesystem walks.