Here is the fully detailed, merged architecture and implementation plan. It retains the complete technical depth, file structures, and code blocks of the original plan while integrating the comprehensive frontend overhaul for the active transfers UI.

---

# LiteSync — Ultra-Lightweight Raspberry Pi File Transfer App

## Context

The user wants a minimal-overhead web app for a Raspberry Pi that lets them browse two local directory trees side by side and kick off `rsync` transfers between them, with the transfer running detached (via `tmux`) so it survives closing the browser.

Key decisions:

* **Stack**: Python + FastAPI (async, built-in SSE-friendly, tiny footprint) served by `uvicorn`, `--workers 1`.
* **Auth**: Built-in lightweight auth (hashed passwords in a config file + signed session cookie)—no PAM/root privilege needed.
* **Filesystem scope**: Browsing/transfers are restricted to admin-configured "allowed root" directories; every path is validated.
* **Progress feed & UI**: Each transfer runs in a detached `tmux` session; `tmux pipe-pane` tees output to a log file, which is streamed to the browser via SSE. The UI will track concurrent transfers using independent, torrent-client style transfer cards.


* **Delete-after-copy**: Appends `--remove-source-files` to rsync, and additionally auto-prunes now-empty source subfolders afterward (scoped to prevent ascending above the selected item).

## Project Structure

```text
/home/homelab/projects/LiteSync/
├── app/
│   ├── __init__.py
│   ├── main.py               # FastAPI app, static mounts, routers, startup reconciliation + poller
│   ├── config.py             # loads config.yaml -> Settings
│   ├── auth.py               # password hashing, signed cookie session, login/logout, lockout
│   ├── fsops.py              # resolve_safe_path(), list_directory() — path-safety module
│   ├── routes_browse.py      # GET /api/roots, GET /api/browse
│   └── tasks/
│       ├── __init__.py
│       ├── db.py             # sqlite3 wrapper: init_db/insert/update/get/list
│       ├── runner.py         # build_rsync_argv, write_task_script, start_tmux_task, poll_running_tasks
│       └── routes.py         # POST /api/transfer, GET /api/tasks[/{id}], SSE stream
├── static/
│   ├── login.html
│   ├── index.html
│   ├── css/app.css           # handwritten CSS including Tailwind utilities for transfer cards
│   └── js/app.js             # dual-pane browser, controls, tab isolation, Map-based SSE state
├── data/                     # gitignored; -> /opt/litesync/data in prod
│   ├── litesync.db
│   └── tasks/<task_id>/{run.sh, log, exit_code}
├── config.example.yaml       # committed template
├── config.yaml               # gitignored, chmod 600 (has bcrypt hashes)
├── requirements.txt
├── litesync.service          # systemd unit
└── README.md

```

## Backend Modules

* **`config.py`**: Reads `config.yaml` via `pyyaml`. Produces `Settings`: `allowed_roots: list[Path]`, `users: list[{username, password_hash}]`, `secret_key`, `session_max_age`, `data_dir`, `tmux_socket_name` (`"litesync"`), `host`, `port`.
* **`auth.py`**: `hash_password`/`verify_password` via `passlib.hash.bcrypt`; `create_session_cookie`/`read_session_cookie` via `itsdangerous.URLSafeTimedSerializer`; `get_current_user` FastAPI dependency; in-memory login-attempt tracker for lockout (5 fails / 15 min).
* **`fsops.py`**: The path-safety module.
* `resolve_safe_path(requested, allowed_roots) -> Path`: Resolves `..` and symlinks, then strictly verifies the result is within an allowed root to avoid string-prefix bypass bugs. Raises 403 on failure.
* `list_directory(path) -> list[dict]`: Re-validates each entry so an in-root symlink pointing back out is skipped.


* **`tasks/db.py`**: Stdlib `sqlite3` at `data_dir/litesync.db` with a `threading.Lock()` guarding writes.
* **`tasks/runner.py`**: Task engine responsible for building bash scripts and tmux isolation.
* **`main.py`**: Builds the app, mounts `static/`, includes routers, and triggers startup reconciliation and the asyncio polling loop.

## API Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/login.html`, `/index.html`, `/` | Static shell; `/` / `/index.html` require a valid session |
| POST | `/api/login` | `{username, password}` → sets signed cookie |
| POST | `/api/logout` | Clears cookie |
| GET | `/api/whoami` | `{"username": ...}` for current session |
| GET | `/api/roots` | Configured allowed roots |
| GET | `/api/browse?path=<abs>` | Validated listing: `{path, parent, entries}` |
| POST | `/api/transfer` | `{sources: [abs...], dest: abs, delete: bool}` → creates task, returns `{task_id}` |
| GET | `/api/tasks?limit=&offset=` | Paginated history |
| GET | `/api/tasks/{task_id}` | Full task detail/status |
| GET | `/api/tasks/{id}/stream` | SSE: replays log, tails live, ends with a `status` event |

## History Data Model (SQLite)

```sql
CREATE TABLE tasks (
  task_id       TEXT PRIMARY KEY,          -- uuid4 hex
  status        TEXT NOT NULL,             -- queued | running | succeeded | failed | interrupted
  sources       TEXT NOT NULL,             -- JSON array of absolute paths
  destination   TEXT NOT NULL,
  delete_source INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,             -- ISO8601
  started_at    TEXT,
  ended_at      TEXT,
  exit_code     INTEGER,
  tmux_session  TEXT NOT NULL,             -- "litesync-<task_id>"
  log_path      TEXT NOT NULL,
  error_message TEXT
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC);

```

## Transfer Engine — tmux/rsync mechanics

All tmux commands use an isolated server via `-L litesync`. Per task:

1. **Build argv**: `["rsync", "-avh", "--progress", "--partial", "--inplace", *sources, destination]`, optionally appending `"--remove-source-files"`.
2. **Write Script**: Creates `run.sh` ensuring all arguments are safely escaped using `shlex.quote()`. If `delete_source` is true, appends a scoped `find` command to delete empty directories.
3. **Create session**: `tmux -L litesync new-session -d -s <session> -x 220 -y 50`.
4. **Attach log tee**: `tmux -L litesync pipe-pane -o -t <session>:0.0 "cat >> <quoted log_path>"`.
5. **Launch + cleanup**: `tmux -L litesync send-keys ... "sh <script_path>; tmux ... kill-session" Enter`.
6. **DB Updates**: Mark `status='running'`, `started_at=now`.
7. **Completion detection**: `runner.poll_running_tasks()` checks the exit code file on an interval, updating SQLite on success or failure.
8. **SSE stream**: Tails the log file, emitting data lines, and closes with a terminal `status` event.

## Frontend (UI Overhaul)

Plain HTML + vanilla JS without npm toolchains.

### Structure Updates (`index.html`)

* The history container is split to enforce strict tab isolation.


* A new `<div id="active-transfers-container" class="cards-container"></div>` is added exclusively for displaying active transfer cards.


* The existing table is explicitly assigned `<table id="history-table" class="hidden">` to display completed tasks only.


* The global `#progress-container` and `#log-view` are removed, as progress tracking is now embedded within each card.


### Styling Updates (`app.css`)

* CSS rules will define `.transfer-card`, `.card-top`, and `.card-path`.


* Required utility classes (e.g., `bg-gray-800`, `bg-blue-600`, `rounded`, `h-5`, `text-xs`, `truncate`) will be manually injected to support the new torrent-client style aesthetic.


### State Management (`app.js`)

* **Dual-Pane Selection:** The source pane allows multi-select (reset on navigation), while the destination pane defaults to its current path.
* **SSE Tracking:** Single-stream logic is replaced by a `Map` (`activeStreams = new Map()`) to manage and track multiple concurrent transfers independently.


* **Tab Isolation:** The `renderHistoryTable()` function strictly filters tasks. Tasks labeled `queued` or `running` render in the active cards container, while `succeeded`, `failed`, or `interrupted` tasks route to the history table. Container visibility is toggled by `state.historyTab`.


* **Card Rendering & Cleanup:** Each active task generates a 4-row HTML card containing progress bars (`#fill-{id}`) and text (`#text-{id}`) updated via SSE. Upon receiving an SSE `status` event (completion/failure), the stream closes, the map entry is deleted, and `loadHistory()` is triggered to automatically remove the card.


* **Auto-Refresh:** Upon task completion or cancellation, `loadPane('source')` and `loadPane('dest')` are immediately invoked to refresh the file browsers without a page reload.


## Security & Deployment

* All user-supplied paths traverse `fsops.resolve_safe_path()`.
* Commands are built as lists and safely quoted; `send-keys` payloads never contain raw user input.
* Runs as a dedicated non-root `litesync` system user. `config.yaml` is `chmod 600`.
* Systemd unit specifies `NoNewPrivileges=true`, `ProtectSystem=strict`, restricting writes to explicit paths.
* Expected footprint: ~30-50MB RSS idle.

## Build Order & Verification Plan

1. **Skeleton + Auth**: Verify secure login and protected routes.
2. **Filesystem Browsing**: Verify `../` escapes are caught and browsing is confined to allowed roots.
3. **Transfer Engine & Card UI**: Implement the SSE streams and the new torrent-style UI cards.
* *Manual Verification 1*: Start a transfer and confirm the Active tab shows a card with the title, truncated path, progress bar, and Cancel button.
* *Manual Verification 2*: Start two transfers sequentially and verify both cards track progress independently and concurrently.

4. **History & Tab Isolation**:
* *Manual Verification 3*: Switch to the Transfer History tab while a transfer is active and verify it is hidden from the table.

* *Manual Verification 4*: When a transfer finishes, confirm the card disappears instantly, routes to the History table, and both file panes refresh automatically.

---
