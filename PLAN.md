# LiteSync — Ultra-Lightweight Raspberry Pi File Transfer App

## Context

The user wants a minimal-overhead web app for a Raspberry Pi that lets them browse two local directory trees side by side and kick off `rsync` transfers between them, with the transfer running detached (via `tmux`) so it survives closing the browser, plus a history view of past/ongoing transfers. `/home/homelab/projects/LiteSync` is currently an empty, non-git directory — this is a from-scratch build.

Key decisions already confirmed with the user:
- **Stack**: Python + FastAPI (async, built-in SSE-friendly, tiny footprint) served by `uvicorn`, `--workers 1`.
- **Auth**: built-in lightweight auth (hashed passwords in a config file + signed session cookie) — no PAM/root privilege needed.
- **Filesystem scope**: browsing/transfers are restricted to one or more admin-configured "allowed root" directories; every path is validated against them.
- **Progress feed**: each transfer runs in a detached `tmux` session; `tmux pipe-pane` tees its output to a per-task log file; the server streams that file to the browser via Server-Sent Events (SSE).
- **Delete-after-copy**: appends `--remove-source-files` to rsync, and additionally auto-prunes now-empty source subfolders afterward (scoped `find -depth -type d -empty -delete` per selected source item — cannot ascend above the selected item, so it's safe).

## Project Structure

```
/home/homelab/projects/LiteSync/
├── app/
│   ├── __init__.py
│   ├── main.py               # FastAPI app, static mounts, routers, startup reconciliation + poller
│   ├── config.py              # loads config.yaml -> Settings
│   ├── auth.py                 # password hashing, signed cookie session, login/logout, lockout
│   ├── fsops.py                 # resolve_safe_path(), list_directory() — path-safety module
│   ├── routes_browse.py          # GET /api/roots, GET /api/browse
│   └── tasks/
│       ├── __init__.py
│       ├── db.py                  # sqlite3 wrapper: init_db/insert/update/get/list
│       ├── runner.py                # build_rsync_argv, write_task_script, start_tmux_task,
│       │                            # poll_running_tasks, reconcile_on_startup
│       └── routes.py                 # POST /api/transfer, GET /api/tasks[/{id}], SSE stream
├── static/
│   ├── login.html
│   ├── index.html
│   ├── css/app.css                    # pre-built Tailwind CLI output (no CDN, no runtime build)
│   └── js/app.js                       # dual-pane browser, controls, modal, history/SSE
├── data/                                 # gitignored; -> /opt/litesync/data in prod
│   ├── litesync.db
│   └── tasks/<task_id>/{run.sh, log, exit_code}
├── config.example.yaml                    # committed template
├── config.yaml                             # gitignored, chmod 600 (has bcrypt hashes)
├── requirements.txt
├── litesync.service                         # systemd unit
└── README.md
```

No repository/service/DI layering — routes call `fsops` / `tasks.db` / `tasks.runner` functions directly. One `tasks/` sub-package because it genuinely has several moving parts (DB, script writer, tmux control, background poller).

## Backend Modules

- **`config.py`** — reads `config.yaml` (path from `LITESYNC_CONFIG` env, default `./config.yaml`) via `pyyaml`. Produces `Settings`: `allowed_roots: list[Path]` (each `Path.resolve()`d once at startup), `users: list[{username, password_hash}]`, `secret_key`, `session_max_age`, `data_dir`, `tmux_socket_name` (`"litesync"`), `host`, `port`.
- **`auth.py`** — `hash_password`/`verify_password` via `passlib.hash.bcrypt`; `create_session_cookie`/`read_session_cookie` via `itsdangerous.URLSafeTimedSerializer`; `get_current_user` FastAPI dependency (redirect to `/login.html`, or 401 for `/api/*`); in-memory login-attempt tracker for lockout (5 fails / 15 min → 15 min lock, per username); `python -m app.auth hash <password>` CLI to generate hashes for `config.yaml`.
- **`fsops.py`** — the path-safety module, used by every endpoint that touches a filesystem path:
  - `resolve_safe_path(requested, allowed_roots) -> Path`: `os.path.realpath()` (resolves `..` and symlinks) then checks the result equals some root or starts with `str(root) + os.sep` — never a bare string-prefix check (avoids the `/data/foo` vs `/data/foobar` bug). Raises 403 on failure.
  - `list_directory(path) -> list[dict]`: `{name, path, is_dir, size, mtime}`, dirs first; re-validates each entry so an in-root symlink pointing back out is skipped.
- **`tasks/db.py`** — stdlib `sqlite3` at `data_dir/litesync.db`, single `tasks` table (schema below), a `threading.Lock()` guarding writes (sufficient for one uvicorn worker; no ORM).
- **`tasks/runner.py`** — task engine, see "Transfer Engine" below.
- **`main.py`** — builds the app, mounts `static/`, includes routers, and on startup: `db.init_db()`, `runner.reconcile_on_startup()`, schedules `runner.poll_running_tasks()` as a background `asyncio` task.

## API Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/login.html`, `/index.html`, `/` | Static shell; `/` / `/index.html` require a valid session |
| POST | `/api/login` | `{username, password}` → sets signed cookie |
| POST | `/api/logout` | Clears cookie |
| GET | `/api/whoami` | `{"username": ...}` for current session |
| GET | `/api/roots` | Configured allowed roots |
| GET | `/api/browse?path=<abs>` | Validated listing: `{path, parent, entries}` |
| POST | `/api/transfer` | `{sources: [abs...], destination: abs, delete_source: bool}` → creates task, launches tmux job, returns `{task_id}` |
| GET | `/api/tasks?limit=&offset=` | Paginated history |
| GET | `/api/tasks/{task_id}` | Full task detail/status |
| GET | `/api/tasks/{task_id}/stream` | SSE: replays existing log, tails live if running, ends with a `status` event |

Login uses a JSON body, so `python-multipart` is not needed (no file uploads anywhere).

## History Data Model (SQLite)

```sql
CREATE TABLE tasks (
  task_id       TEXT PRIMARY KEY,          -- uuid4 hex
  status        TEXT NOT NULL,              -- queued | running | succeeded | failed | interrupted
  sources       TEXT NOT NULL,               -- JSON array of absolute paths
  destination   TEXT NOT NULL,
  delete_source INTEGER NOT NULL DEFAULT 0,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL,               -- ISO8601
  started_at    TEXT,
  ended_at      TEXT,
  exit_code     INTEGER,
  tmux_session  TEXT NOT NULL,               -- "litesync-<task_id>"
  log_path      TEXT NOT NULL,
  error_message TEXT
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC);
```

Structured metadata lives in SQLite; large append-only log content stays in per-task files on disk, referenced by `log_path`.

## Transfer Engine — tmux/rsync mechanics

All tmux commands use an isolated server via `-L litesync` so LiteSync sessions never collide with any other tmux usage. Per task (`task_id = uuid4().hex`, `session = f"litesync-{task_id}"`):

1. **Build argv**: `["rsync", "-avh", "--progress", "--partial", "--inplace", *sources, destination]`, appending `"--remove-source-files"` when `delete_source` is set. Never shell-interpolated — assembled as a Python list.
2. **Write `data/tasks/<task_id>/run.sh`** (mode `0700`, each arg via `shlex.quote()`):
   ```sh
   #!/bin/sh
   <quoted rsync argv>
   echo $? > <quoted exit_code_path>
   ```
   If `delete_source` is set, append one line per selected **directory** source `D`:
   ```sh
   find <quoted D> -depth -type d -empty -delete
   ```
   (runs after rsync; scoped to `D` itself, so it structurally cannot prune anything above the selected item).
3. **Create session idle**: `tmux -L litesync new-session -d -s <session> -x 220 -y 50` (plain shell prompt, no output missed).
4. **Attach log tee**: `tmux -L litesync pipe-pane -o -t <session>:0.0 "cat >> <quoted log_path>"`.
5. **Launch + self-cleanup**: `tmux -L litesync send-keys -t <session>:0.0 "sh <script_path>; tmux -L litesync kill-session -t <session>" Enter`. This string only ever contains server-generated identifiers (task_id-derived), never raw user input — sidesteps `send-keys` quoting hazards entirely.
6. **DB**: mark `status='running'`, `started_at=now` right after step 5.
7. **Completion detection**: `runner.poll_running_tasks()` (asyncio loop, ~2s interval) checks `exit_code_path` for each `running` row; on appearance, reads the code, sets `succeeded`/`failed`, `ended_at`, `error_message` on failure; belt-and-suspenders `has-session` check to kill any session that didn't self-clean.
8. **SSE stream (`/api/tasks/{id}/stream`)**: tails `log_path` from offset 0, splitting on `[\r\n]` (rsync's `--progress` redraws lines with `\r`), emitting `data: <line>\n\n`; sleeps 0.5s between checks while running; on terminal status, drains remaining bytes, emits `event: status\ndata: {...}\n\n`, and returns — one code path serves both live tailing and pure historical replay.

**Startup reconciliation** (`reconcile_on_startup`): for every DB row still `status='running'`, check `tmux -L litesync has-session`. If it exists, leave it running (the poller resumes tracking it). If gone: finalize from `exit_code_path` if present, else mark `status='interrupted'` with an explanatory `error_message`.

## Frontend

Plain HTML + vanilla JS, no npm/build toolchain on the Pi. Tailwind is compiled once during development via the standalone Tailwind CLI into a committed `static/css/app.css` (avoids depending on the Pi having outbound internet, and avoids shipping a JIT compiler to the browser).

- **`login.html`** — username/password form, `fetch` POST to `/api/login`.
- **`index.html`** — dual-pane shell (`#source-pane`, `#dest-pane`), controls bar (Transfer button + delete checkbox), confirmation modal, history panel.
- **`js/app.js`**:
  - `browsePane(pane, path)` renders entries from `/api/browse`; source pane shows a checkbox per entry, selection kept in a JS `Set` that **resets whenever the source pane navigates to a new directory** (selection is scoped to one directory, matching the spec).
  - Destination pane has no checkboxes — whichever directory it's currently browsing *is* the destination (simplest UX for "selecting a destination directory").
  - Transfer click → confirmation modal ("Are you sure you want to transfer the selected items?") listing selected names + destination → on confirm, `POST /api/transfer`, then `new EventSource('/api/tasks/{id}/stream')` streams live output into a log view.
  - History panel: `GET /api/tasks` on load, status badges; clicking a row opens its log via the same SSE endpoint.

## Security

- Every user-supplied path (both browse and each transfer source/destination individually) goes through `fsops.resolve_safe_path()` — no exceptions.
- rsync argv built as a list, never a shell string, until written into `run.sh` with `shlex.quote()` per arg; `send-keys` payload never contains raw user input.
- Session cookie: `HttpOnly`, `SameSite=Lax`, `Secure` (config flag, default off for plain-HTTP LAN, documented for TLS setups), `max_age` enforced server-side on every read.
- Optional login lockout (5 fails / 15 min) — in-memory, resets on restart, acceptable given the small LAN threat model.
- App runs as a dedicated non-root `litesync` system user with read/write only on configured allowed roots and `data/`. `config.yaml` is `chmod 600`.
- Destination must be an existing directory inside an allowed root — creating new folders via the UI is out of scope.

## Deployment (Raspberry Pi)

- **Deps** (`requirements.txt`): `fastapi`, `uvicorn` (no `[standard]` extras, avoids ARM wheel issues — plain asyncio loop is plenty at this scale), `passlib[bcrypt]`, `itsdangerous`, `pyyaml`. Stdlib covers `sqlite3`/`subprocess`. System packages: `tmux`, `rsync`, `python3-venv`.
- **Process model**: `uvicorn app.main:app --workers 1` — deliberate, since the tmux registry, poller, and sqlite writes are centralized in-process.
- **systemd unit** (`litesync.service`): `User=litesync`, `Restart=on-failure`, `NoNewPrivileges=true`, `ProtectSystem=strict` with `ReadWritePaths` explicitly listing `data/` plus every configured allowed root.
- No reverse proxy required at this scale; uvicorn serves directly. Add nginx later only if TLS termination is wanted.
- Expected footprint: ~30-50MB RSS idle for uvicorn/FastAPI — comfortable on a Pi Zero 2 W and up.

## Build Order

1. **Skeleton + auth**: `config.py`, `auth.py`, `main.py` serving placeholder pages, `litesync.service` stub, README. *Verify*: login/logout, protected-page redirect.
2. **Filesystem browsing**: `fsops.py`, `/api/roots`, `/api/browse`, dual-pane UI with navigation + source multi-select. *Verify*: `../` and symlink-escape attempts return 403; browsing never leaves allowed roots.
3. **Transfer engine**: `tasks/db.py`, `tasks/runner.py`, `POST /api/transfer`, confirmation modal, SSE stream, delete-checkbox + empty-dir pruning. *Verify*: a real transfer streams live progress in the browser, `tmux -L litesync ls` shows the session disappear on completion, both success and induced-failure runs record correctly, delete-source removes files and prunes emptied subfolders.
4. **History + reconciliation**: `/api/tasks`, `/api/tasks/{id}`, history panel, `reconcile_on_startup`. *Verify*: `kill -9` the uvicorn process mid-transfer, confirm rsync/tmux keep running independently, restart the app and confirm correct reconciliation (still-running vs. session-lost → `interrupted`).
5. **Polish**: tune systemd `ReadWritePaths` to real paths, finalize README (Pi install steps, `config.yaml` setup, hash CLI usage, enabling the service), final security pass (grep for `shell=True`, verify cookie flags, `chmod 600 config.yaml`).

## Verification

- Automated: none beyond manual smoke checks appropriate for a project this size — no test framework is being added given scope/footprint goals; each phase above has its own concrete manual verification step.
- End-to-end: after Phase 3, run a real transfer of a small test tree between two temp directories on the dev machine (or the Pi once deployed), confirming rsync's `-avh --progress --partial --inplace` output streams live, the tmux session (`tmux -L litesync ls`) is gone afterward, and the DB/history row reflects the correct final status.
