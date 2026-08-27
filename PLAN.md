```markdown
# LiteSync — Architecture & Implementation Plan

## 1. System Context & Core Principles
Minimal-overhead Raspberry Pi web app for dual-pane local directory browsing and background `rsync` transfers.
* **Stack**: Python + FastAPI (async, SSE-friendly) on `uvicorn` (`--workers 1`). Vanilla HTML/JS/CSS frontend.
* **Auth**: Built-in lightweight auth (YAML hashed passwords, signed session cookies).
* **Security**: Filesystem constrained to admin-configured "allowed roots". `fsops.resolve_safe_path()` strictly validates all paths against traversal/symlink escapes.
* **Transfer Engine**: Background asyncio subprocess worker. Survives browser closures (no `tmux`). Logs pipe directly to per-task files, streamed to UI via SSE.
* **UI Paradigms**: Single-page application (SPA). Independent transfer cards (1 per source). Contextual modals for file mutation. Toast notifications. Activity log.

## 2. Project Structure
```text
/home/homelab/projects/LiteSync/
├── app/
│   ├── __init__.py
│   ├── main.py               # FastAPI app, static mounts, routers, startup poller/reconciliation
│   ├── config.py             # Loads config.yaml -> Settings object
│   ├── auth.py               # passlib bcrypt hashing, signed cookies, login/lockout logic
│   ├── fsops.py              # resolve_safe_path(), list_directory() — path validation
│   ├── routes_browse.py      # /api/roots, /api/browse, /api/mkdir | rename | delete
│   └── tasks/
│       ├── __init__.py
│       ├── db.py             # sqlite3 wrapper (init, CRUD, next_queued_task)
│       ├── runner.py         # rsync argv, asyncio subprocess scheduler, SIGTERM, fast-path move
│       └── routes.py         # POST /api/transfer, GET /api/tasks, SSE stream generator
├── static/
│   ├── login.html
│   ├── index.html            # Main SPA shell
│   ├── css/app.css           # Vanilla CSS (custom properties, responsive flex, modals, popovers)
│   └── js/app.js             # Dual-pane logic, SSE Map, Toast/Activity system, Modal handlers
├── data/                     # Gitignored runtime data
│   ├── litesync.db
│   └── tasks/<task_id>/{run.sh, log, exit_code, pid}
├── config.example.yaml
├── config.yaml               # Gitignored (chmod 600)
├── requirements.txt
├── litesync.service          # systemd unit (NoNewPrivileges=true, ProtectSystem=strict)
└── README.md

```

## 3. Database Schema (SQLite)

`data/litesync.db` guarded by `threading.Lock()`.

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
  tmux_session  TEXT NOT NULL,             -- legacy column, always ''
  log_path      TEXT NOT NULL,
  error_message TEXT
);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_created_at ON tasks(created_at DESC);

```

## 4. Backend Engine & API Endpoints

### API Routing

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/whoami`, `/api/roots` | Session context & configured root validation. |
| GET | `/api/browse?path=<abs>` | Returns `{path, parent, entries}`. Filters out-of-root symlinks. |
| GET | `/api/download?path=<abs>` | Streams requested file using `FileResponse` for authenticated users. |
| POST | `/api/mkdir` | `{path, name}` → `Path.mkdir()`. Rejects slashes/collisions. |
| POST | `/api/rename` | `{path, new_name}` → `Path.rename()`. Refuses renaming roots. |
| POST | `/api/delete` | `{path}` → `shutil.rmtree()` / `unlink()`. Refuses deleting roots. |
| POST | `/api/transfer` | `{sources: [abs...], dest, delete}` → Queues 1 task **per source**. |
| GET | `/api/tasks`, `/{id}` | Task history pagination and detail retrieval. |
| GET | `/api/tasks/{id}/stream` | SSE: yields live log tail, closes with `status` event. |

*Note: Mutation endpoints traverse `resolve_safe_path` for **both** source and target paths before execution.*

### Transfer Engine (Asyncio Subprocess)

1. **FIFO Scheduler:** `queue_task` inserts DB row → `wake_scheduler()` triggers `asyncio.create_subprocess_exec`. Runs one concurrent task.
2. **Direct Logging:** Process `stdout`/`stderr` piped straight to `<task_dir>/log` (no `tee` hacks).
3. **Same-Filesystem Fast Path:** If `os.stat(src).st_dev == dest.st_dev` AND `delete_source` is True, `runner.py` bypasses `rsync` and executes atomic `shutil.move()`. Writes instant `100%` summary to log, marks `succeeded`. Falls back to `rsync` on `OSError` (e.g., merge conflicts).
4. **Lifecycle & Pruning:** On success with `delete_source`, python executes `os.walk(topdown=False)` + `os.rmdir` to prune empty source parent paths (scoped strictly to selected item).
5. **Startup Reconciliation:** Stale `running` tasks marked `interrupted`. Validates PID via `/proc/<pid>/cmdline` and sends best-effort `SIGTERM`. Queued tasks survive and resume automatically.

## 5. Frontend Architecture (Vanilla HTML/CSS/JS)

### Layout & Responsiveness (`app.css` / `app.js`)

* **CSS Variables:** Layout dimensions (`--left-width`, `--top-height`, `--bottom-height`) applied to `:root`. JS `initResizers()` updates CSS vars on drag; DOM reflows automatically via `@media` queries.
* **Mobile View (`max-width: 768px`):** Flex-direction flips to `column`. Panes stack vertically. Pane headers wrap dynamically (Label/Path on row 1; Action buttons on row 2).
* **Dual-Pane Logic:** Both Source and Dest panes share identical toolbars (`📁+`, `✏️`, `🗑️`). Selections are isolated (`state.selection` vs `state.destSelection`). Auto-refreshes seamlessly on mutation success without full page reloads.

### File Mutation Modals & Toasts

* **Modals:** Reusable styling (`.modal-backdrop`, `.modal`). Dedicated popups for Mkdir, Rename, Delete, and Confirmations. Features autofocus, Enter-to-submit, Esc-to-cancel, and `.modal-error` inline validation.
* **Toasts (`.toast-stack`):** Top-right fixed position. Auto-dismiss (4s) or click-to-dismiss. Slide-in animations. Used for all operation feedback.
* **Activity Log (`localStorage`):** Retains last 200 events (mutations, transfer completions/failures). Color-coded by severity. Replaces the legacy "Transfer History" tab.

### Active Transfers UI (Overhaul)

* **Unbatched Cards:** Multi-item transfers spawn individual `.transfer-card` elements (one per item). Queued items show `Queued...` and can be canceled before execution. Sorted by `running` first, then `queued` (FIFO).
* **Selection Action Bar:**
* Hidden completely when selection count is 0.
* Flex layout pushed to the right side (Summary | View | Clear), adjacent to the `Transfer` button.
* System-matching square-ish `border-radius`. `Clear` is a text/ghost button (red on hover). On mobile, the bar flex-wraps into two rows to prevent crowding.


* **Transfer Confirmation Modal:** The `[x] Delete source files after successful copy` checkbox is moved *inside* the Transfer confirmation modal to prevent accidental destructive ops, placed directly under the Destination path.
* **Contextual View Popover:** Clicking "View" opens a popover anchored relative to the button (via wrapper `position: relative` / popover `position: absolute`).
* Features `overflow-y: auto` and `max-height: 350px`.
* Uses `word-break: break-word` and `white-space: normal` to wrap full absolute paths without truncating.
* On mobile (`<=768px`), uses `position: fixed` centered at bottom to avoid container clipping.

### File Browser UX & Inspection

* **Full Path Tooltips (Desktop Hover + Mobile Long-Press):**
  * Standard HTML `title` attributes attached to each `.entry` row provide native hover tooltips on desktop for truncated paths.
  * On touch devices (`window.matchMedia('(hover: none)')`), a ~500ms long-press listener (`touchstart`/`touchend`/`touchmove`/`touchcancel`) displays a non-intrusive `showToast(entry.path, 'info')` notification.
* **Copy Download Link to Clipboard (`.btn-copy-path`):**
  * Subtle icon button (`📋`) rendered specifically on file rows (`!entry.is_dir`).
  * Copies a fully qualified download URL (`${window.location.origin}/api/download?path=...`) directly to the clipboard via `navigator.clipboard.writeText`.
  * Visual feedback: Swaps icon to green checkmark (`✓`) for 1.5 seconds and emits `toastSuccess('Link copied to clipboard')`.
  * Responsive visibility: Completely hidden on desktop until row hover (`@media (hover: hover) { opacity: 0 } -> :hover { opacity: 1 }`), but permanently visible (`opacity: 0.6`) on mobile/touch interfaces.
  * Clicks isolate propagation (`e.stopPropagation()` & target checks) to prevent triggering parent row selection or navigation.

## 6. Security & Deployment

* **Path Confinement:** All user-supplied paths strictly traverse `fsops.resolve_safe_path()`. Escapes via `../` or symlinks pointing outside the allowed roots resolve to a `403 Forbidden`.
* **Subprocess Safety:** Commands are built as argument lists (e.g., `["rsync", "-av", ...]`) and passed directly to `asyncio.create_subprocess_exec`. No shell (`shell=True`) is used, entirely eliminating shell-injection vectors.
* **Permissions:** The app runs as a dedicated, non-root `litesync` system user. The `config.yaml` containing bcrypt hashes must be strictly `chmod 600`.
* **Systemd Hardening:** The `litesync.service` unit file mandates `NoNewPrivileges=true` and `ProtectSystem=strict`, ensuring the worker process cannot escalate privileges and can only write to explicitly whitelisted directories (like its own `/opt/litesync/data` and the configured destination roots).
* **Resource Footprint:** Expect a highly efficient ~30-50MB RSS footprint while idle, fitting easily within older Raspberry Pi hardware limits.

## 7. Build Order & Verification Plan

**1. Skeleton + Auth**

* Verify secure login, lockout behavior on 5 failed attempts, and proper 401/403 rejection on protected API routes without a valid signed session cookie.

**2. Filesystem Browsing**

* Verify directory navigation is strictly confined to `allowed_roots`.
* Attempt to manually request a `../` path via the API and ensure it is caught.

**3. Transfer Engine & Card UI**

* *Verification 3a:* Start a transfer and confirm the Active tab shows a single card with the file title, truncated path, live progress bar, and Cancel button.
* *Verification 3b:* Submit a multi-item batch. Verify each item generates its own card. Item 1 should stream live progress while the rest show `Queued...`. As one finishes, the next promotes to running.
* *Verification 3c:* Cancel a `Queued...` item. Confirm it drops out of the queue immediately without touching the filesystem.
* *Verification 3d:* Resize the browser on desktop and mobile. Ensure splitters drag horizontally (desktop, 20–80% clamp) and vertically (mobile, stacking 50/50).

**4. File-Operations API + Dual-Pane Parity**

* *Verification 4a:* Select exactly one item, click `✏️ Rename`. Verify the modal opens with the name prefilled. Submit a new name, verify the success toast appears, the pane refreshes, and the selection migrates to the new path.
* *Verification 4b:* Multi-select 2 items, click `🗑️ Delete`. Verify the modal lists both names. Confirm deletion, verify toasts, and ensure the pane refreshes automatically.
* *Verification 4c:* Verify the pane headers wrap cleanly on mobile view (`<= 768px`) without overlapping the `📁+ ✏️ 🗑️` buttons.
* *Verification 4d:* Verify the selection action bar (View, Clear, Transfer) properly wraps on mobile, and the "View" popover correctly anchors to the bottom of the screen to prevent edge clipping.

**5. Activity Log & Notifications**

* *Verification 5a:* Trigger a mkdir, rename, delete, and transfer. Switch to the Activity Log tab. Confirm entries appear in reverse chronological order with timestamp, `[kind]` prefix, and color-tinted borders.
* *Verification 5b:* Confirm each action also triggers a top-right toast that auto-dismisses in 4 seconds.
* *Verification 5c:* Reload the page. Confirm the Activity Log still contains the entries (testing `localStorage` persistence).
* *Verification 5d:* Click the red "Clear Log" button. Confirm the log view empties and the button hides itself.

**6. Same-Filesystem Fast Path**

* *Verification 6a:* With `[x] Delete source files` checked inside the Transfer Modal, move a folder between two paths **on the same mount point**. Confirm no `rsync` runs, the UI logs an instant `100%`, and the task lands in the Activity Log as `succeeded`.
* *Verification 6b:* Verify the moved item instantly vanishes from the source pane and appears in the destination without requiring a manual browser refresh.
* *Verification 6c:* Repeat the move but pre-create a conflicting folder in the destination. Confirm `shutil.move()` safely falls back to standard `rsync` merge execution instead of failing.

**7. File Inspection & Download URL Copy**

* *Verification 7a:* Hover over a file or folder on desktop. Confirm the native browser tooltip shows the full absolute path.
* *Verification 7b:* On touch devices, long-press a row for ~500ms. Verify a toast appears displaying the full path without accidental navigation.
* *Verification 7c:* Confirm `.btn-copy-path` appears only on file rows (omitted from folders).
* *Verification 7d:* On desktop, confirm the copy icon is hidden until row hover; on mobile, verify it remains visible.
* *Verification 7e:* Click the copy button. Confirm icon turns into a checkmark (`✓`), toast confirms copy, and the clipboard contains `http://<ip>:<port>/api/download?path=...`.
* *Verification 7f:* Open the copied download URL in a browser tab. Confirm the file downloads directly.

```

```