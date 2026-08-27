Here is the fully detailed, merged architecture and implementation plan. It retains the complete technical depth, file structures, and code blocks of the original plan while integrating the comprehensive frontend overhaul for the active transfers UI.

---

# LiteSync — Ultra-Lightweight Raspberry Pi File Transfer App

## Context

The user wants a minimal-overhead web app for a Raspberry Pi that lets them browse two local directory trees side by side and kick off `rsync` transfers between them, with transfers running as background subprocesses of the uvicorn worker so they survive closing the browser (no `tmux` dependency).

Key decisions:

* **Stack**: Python + FastAPI (async, built-in SSE-friendly, tiny footprint) served by `uvicorn`, `--workers 1`.
* **Auth**: Built-in lightweight auth (hashed passwords in a config file + signed session cookie)—no PAM/root privilege needed.
* **Filesystem scope**: Browsing/transfers are restricted to admin-configured "allowed root" directories; every path is validated.
* **Progress feed & UI**: Each transfer's `stdout`/`stderr` is piped by the background worker directly into a per-task log file, which is streamed to the browser via SSE. The UI tracks transfers using independent, torrent-client style transfer cards — **one card per selected item** (batch submissions are unbatched server-side and executed by a sequential queue).


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
│       ├── db.py             # sqlite3 wrapper: init/insert/update/get/list/next_queued_task
│       ├── runner.py         # build_rsync_argv, queue_task, run_scheduler (asyncio subprocess worker),
│       │                     # terminate_task (SIGTERM), wake_scheduler, reconcile_on_startup
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

* **`config.py`**: Reads `config.yaml` via `pyyaml`. Produces `Settings`: `allowed_roots: list[Path]`, `users: list[{username, password_hash}]`, `secret_key`, `session_max_age`, `data_dir`, `host`, `port`.
* **`auth.py`**: `hash_password`/`verify_password` via `passlib.hash.bcrypt`; `create_session_cookie`/`read_session_cookie` via `itsdangerous.URLSafeTimedSerializer`; `get_current_user` FastAPI dependency; in-memory login-attempt tracker for lockout (5 fails / 15 min).
* **`fsops.py`**: The path-safety module.
* `resolve_safe_path(requested, allowed_roots) -> Path`: Resolves `..` and symlinks, then strictly verifies the result is within an allowed root to avoid string-prefix bypass bugs. Raises 403 on failure.
* `list_directory(path) -> list[dict]`: Re-validates each entry so an in-root symlink pointing back out is skipped.


* **`tasks/db.py`**: Stdlib `sqlite3` at `data_dir/litesync.db` with a `threading.Lock()` guarding writes.
* **`tasks/runner.py`**: Task engine: rsync argv construction, the asyncio subprocess scheduler, cancellation, and startup reconciliation.
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
| POST | `/api/transfer` | `{sources: [abs...], dest: abs, delete: bool}` → queues one task **per source**, returns `{task_ids: [...]}` |
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
  tmux_session  TEXT NOT NULL,             -- legacy column, always '' (kept to avoid a schema migration)
  log_path      TEXT NOT NULL,
  error_message TEXT
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC);

```

## Transfer Engine — subprocess/rsync mechanics

`tmux` has been fully removed. The engine is a single in-process asyncio worker using native subprocess management — the rsync children belong to the uvicorn worker, so closing the browser, expiring a session, or dropping the SSE stream never interrupts a transfer. The model is **Queue → FIFO Scheduler → one subprocess at a time**:

1. **Queue** (`queue_task`): per selected source, insert a DB row with `status='queued'` and a per-task log path. `POST /api/transfer` is strictly fire-and-forget: queue rows, `wake_scheduler()`, return `{task_ids}` immediately.
2. **Schedule** (`run_scheduler`, started in `main.py` startup): when nothing is running, promote the oldest queued task (`mark_running`) and execute it with `asyncio.create_subprocess_exec`; an `asyncio.Event` wake-up makes new submissions start instantly, with a 1s fallback tick.
3. **Direct logging**: the child's `stdout`/`stderr` are piped straight into `<task_dir>/log`, keeping every per-task SSE stream isolated. No pipes, no shell scripts, no tee hacks.
4. **Completion**: the worker `await`s the process, then finalizes (`succeeded` / `failed` with exit code) — but only if the row is still `running`, so a cancel never gets overwritten. Delete-source pruning (`find -empty -delete` equivalent) is implemented in Python via `os.walk(topdown=False)` + `os.rmdir`, scoped to the selected item.
5. **PID tracking**: the live child's PID is written to `<task_dir>/pid` (no schema migration) and removed on completion.
6. **Cancel semantics**:
   * *Queued item*: mark `interrupted` — the scheduler only selects `queued` rows, so it is skipped. Filesystem untouched.
   * *Running item*: `terminate_task()` sends SIGTERM to the tracked subprocess; a 5s watchdog in the worker escalates to SIGKILL if ignored. Partial destination copies are pruned by the existing cleanup logic.
7. **Startup reconciliation**: every stale `running` task is marked `interrupted`; its recorded PID, if still alive (verified via `/proc/<pid>/cmdline` containing `rsync` to guard PID reuse), is best-effort SIGTERMed. Queued tasks survive restarts and simply resume through the scheduler.
8. **SSE stream**: tails each task's log file, emitting data lines, closing with a terminal `status` event.

### Same-filesystem fast path (instant rename for delete-after-copy)

In `app/tasks/runner.py`, `_run_task()` inspects the source and destination paths **before spawning rsync**. `_same_filesystem()` compares `os.stat(src).st_dev` for every source against the destination (or its parent if the destination does not exist) — identical device IDs mean the paths share a mount point/filesystem.

When both are on the same filesystem and `delete_source` is `True`, the worker bypasses the external rsync subprocess entirely: `_fast_move()` performs an immediate `shutil.move()` per source (an atomic `rename(2)` on a shared filesystem, with a built-in fallback to copy+delete if rename is refused). It then:

1. writes the source basename plus an instant ``100%`` progress line to the task's log file (an rsync-style summary line the existing SSE replay + `(/\d+)%/` progress parsing render as an immediate 100% completion),
2. records `mark_finished(task_id, 'succeeded', 0, None)` in SQLite at once — the SSE generator then replays the log and closes with the terminal `status` event.

**Fallback:** if `shutil.move()` raises any `OSError` (e.g. the destination entry already exists, where rsync would merge instead of overwrite), `_fast_move()` returns `False` and the task transparently falls through to the normal rsync subprocess path — the fast path never turns a mergable conflict into a failure.

**Frontend implication:** an instant move can complete inside the `POST /api/transfer` round-trip, before any card is rendered or SSE stream attached — the very first `GET /api/tasks` may already return `succeeded`. `loadHistory()` therefore embeds a completion watcher: any task transitioning from an active state (queued/running) to a terminal one, or a never-seen task created within the last 30s that already finished, routes through `onTaskFinished(status, task)` — pruning completed source paths from the persistent selection (`state.selection`, with trailing-slash-normalized comparison), updating the selection bar, and cache-bust force-refreshing both panes. A `state.finishedTaskIds` set deduplicates SSE status events, cancel callbacks, and the watcher. `loadPane('source', ...)` clears the selection only on actual navigation, so its same-path preserve-refresh no longer stomps the pruning. If the currently viewed source directory itself was the moved item, the `/api/browse` 404 falls back to its parent directory.

**Atomicity note:** with the `st_dev` gate, `shutil.move()` uses `os.rename()` strictly on one filesystem and is atomic (destination appears fully formed; no partial-copy window). `os.rename`'s rare same-fs refusals fall back inside `shutil` to copy+delete; should strict atomic-only semantics ever be required, `_fast_move` can switch to a bare `os.rename()` that simply returns `False` on failure to trigger the rsync fallback.

## Frontend (UI Overhaul)

Plain HTML + vanilla JS without npm toolchains.

### Structure Updates (`index.html`)

* `<meta name="viewport" content="width=device-width, initial-scale=1" />` added to both `index.html` and `login.html` — without it, mobile devices/devtools render a ~980px virtual viewport and responsive media queries never match.
* Two splitter drag handles added: `#vertical-splitter` (between source/destination panes) and `#horizontal-splitter` (between the controls bar and history). Both carry `splitter-v`/`splitter-h` classes.
* The history container is split to enforce strict tab isolation.
* A new `<div id="active-transfers-container" class="cards-container"></div>` is added exclusively for displaying active transfer cards.
* The existing table is explicitly assigned `<table id="history-table" class="hidden">` to display completed tasks only.
* The global `#progress-container` and `#log-view` are removed, as progress tracking is now embedded within each card.

### Responsive Layout (`app.css`) — CSS Variable Resizing Architecture

Handwritten CSS only — **no Tailwind, no build step**. The layout skeleton was rebuilt around CSS custom properties consumed inside `@media` blocks, thus making mobile overrides automatic (JS never needs media-query listeners or inline-style cleanup):

* **Viewport ownership**: `html, body { height: 100% }`; `body` is the flex column owning the viewport (`display: flex; flex-direction: column; overflow: hidden`). `header` and `.controls` are `flex: none`; `.panes` is `flex: 1; min-height: 0`.
* **Desktop (`min-width: 769px`)**: `#source-pane { width: var(--left-width, 50%); flex: none }`, `#dest-pane { flex: 1 }`, `.history { height: var(--bottom-height, 220px); flex: none }`. The old CSS-grid `.panes` with rigid `calc(100vh - ...)` heights was removed.
* **Mobile (`max-width: 768px`)**: `.panes` flips to `flex-direction: column`; `#source-pane { height: var(--top-height, 50%); flex: none }`; `#dest-pane { flex: 1 1 0 }`. The same `#vertical-splitter` element repurposes as a full-width horizontal handle (`cursor: row-resize`) between the stacked panes; `#horizontal-splitter` stays functional (history still consumes `--bottom-height`, default 200px).
* **Splitters**: 6px `var(--border)` strips with accent hover/drag states (`.splitter-dragging`).
* **Pane headers**: fixed `height: 40px; flex: none; align-items: center`, so adding/removing action buttons (e.g., `+ New Folder`) can never shift header height or baseline alignment between panes.
    
### Resizer Logic (`app.js`) — `initResizers()`

* Pointer Events with `setPointerCapture` (covers mouse + touch; no touch-event plumbing required).
* **Orientation-aware pane splitter**: read `getComputedStyle(panes).flexDirection` at drag time — row (desktop): X-axis sets `--left-width`, clamped 20–80% of viewport; column (mobile): Y-axis sets `--top-height`, clamped 20–80% of the panes container.
* **History splitter**: height measured via `.history.getBoundingClientRect().bottom - clientY` (accounts for the controls strip), clamped 120px–70% of viewport, sets `--bottom-height`.
* All values are set on `:root` via `style.setProperty()`; JS never applies inline pane dimensions.

### Styling Updates (`app.css`)

* CSS rules will define `.transfer-card`, `.card-top`, and `.card-path`.
* Required utility classes (e.g., `bg-gray-800`, `bg-blue-600`, `rounded`, `h-5`, `text-xs`, `truncate`) are manually injected to support the new torrent-client style aesthetic.


### State Management (`app.js`)

* **Dual-Pane Selection:** The source pane allows multi-select (reset on navigation), while the destination pane defaults to its current path.
* **Unbatched Cards:** The backend expands a multi-item submission into one task per source, so each card displays the plain basename of its item (the `(+X more)` grouping was removed from `getPrimaryTitle()`). Queued items render identical cards with a `Queued...` detail line, 0% bar, and a working Cancel button.
* **Active Tab Sorting:** `renderHistoryTable()` orders active cards by status priority (`running` first, then `queued`) with `created_at ASC` (FIFO) as the tie-breaker. Promotion of the next queued item re-sorts automatically on the existing status-change → `loadHistory()` cycle.
* **SSE Tracking:** Single-stream logic is replaced by a `Map` (`activeStreams = new Map()`) to manage and track multiple concurrent transfers independently.


* **Tab Isolation:** The `renderHistoryTable()` function strictly filters tasks. Tasks labeled `queued` or `running` render in the active cards container, while `succeeded`, `failed`, or `interrupted` tasks route to the history table. Container visibility is toggled by `state.historyTab`.


* **Card Rendering & Cleanup:** Each active task generates a 4-row HTML card containing progress bars (`#fill-{id}`) and text (`#text-{id}`) updated via SSE. Upon receiving an SSE `status` event (completion/failure), the stream closes, the map entry is deleted, and `loadHistory()` is triggered to automatically remove the card.


* **Auto-Refresh:** Upon task completion or cancellation, `loadPane('source')` and `loadPane('dest')` are immediately invoked to refresh the file browsers without a page reload. A completion watcher inside `loadHistory()` guarantees this even for the instantaneous same-filesystem fast path, which can finish before an SSE stream ever attaches; terminal-transition detection in the polls keeps pane refreshes symmetric to rsync completions.


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
* *Manual Verification 2*: Submit a multi-item transfer and verify each item gets its own card: item 1 streams live progress while the rest show `Queued...`, and each queued item promotes itself to the top with live progress when the previous one finishes.
* *Manual Verification 2a*: Cancel a queued item and confirm it drops out of the queue without touching the filesystem.
* *Manual Verification 2b*: Drag both splitters on desktop (20–80% / 120px–70% clamps), then switch to a ≤768px viewport and confirm the panes stack vertically 50/50 and the inter-pane splitter drags vertically.

4. **History & Tab Isolation**:
* *Manual Verification 3*: Switch to the Transfer History tab while a transfer is active and verify it is hidden from the table.

* *Manual Verification 4*: When a transfer finishes, confirm the card disappears instantly, routes to the History table, and both file panes refresh automatically.

5. **Same-filesystem fast path**:
* *Manual Verification 5*: With `delete_source` checked, move a folder from one allowed root to another root **on the same mount**; confirm no rsync runs (no `pid` file, log starts with an instant `100%` line), the task lands straight into the History tab as `succeeded`, the moved folder vanishes from the source pane and appears in the destination without a manual refresh, and the source pane's selection box is unchecked for the moved item.
* *Manual Verification 5a*: Repeat with a destination entry of the same name already present — the move should fall back to rsync's merge semantics rather than fail.

---
