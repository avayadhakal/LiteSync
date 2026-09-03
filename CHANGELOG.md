# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]
### Added
- **Linux & Multi-Architecture Support:** Expanded installer (`install.sh`) to support both `arm64`/`aarch64` and `x86_64`/`amd64` architectures for general Linux deployments, single-board computers, NAS devices, and homelabs.
- **Unified File-Action Dialog:** Replaced mobile long-press gestures with unified double-click (desktop) and double-tap (touch) interactions opening an Item Details dialog with file inspection, safe in-browser viewing, and link copying.
- **Inline Text Editor & File Action Dialog:** Added a lightweight in-browser text editor for small supported text files like `.txt`, `.md`, `.py`, `.json`, `.toml`, and `.yaml` up to 2MB. Added file change checks, safe saving, maximize/restore, and activity logging. Larger or unsupported files continue to use the normal browser download
- **Safe Inline File Viewing:** Direct in-browser viewing via signed URLs (`/api/download/link?disposition=inline`), protected by a strict server-side MIME allowlist, safe `text/plain` fallback for executable markup (HTML, SVG, XML, XHTML), and mandatory `X-Content-Type-Options: nosniff` headers to prevent stored XSS.
- **Transfer Engine:** Robust background processing utilizing `rsync` or zero-copy `os.copy_file_range` kernel transfers.
- **Direct Uploads:** Streamed multipart browser uploads straight to disk, circumventing memory exhaustion.
- **Downloads:** Secure file downloads via signed URLs supporting HTTP Range requests.
- **Recursive Selection:** Intelligent hierarchical selection model allowing arbitrary sub-item exclusions.
- **Activity Log:** SQLite-backed persistent real-time activity tracking and toast notification system.
- **Mobile UX:** Fully responsive dual/single pane layout dynamically adapting to mobile viewports.
- **Transfer Controls:** Pause and resume active background `rsync` transfers natively.
- **Conflict Resolution:** Safely skip, keep both, or replace existing files during transfers with pre-flight resolution.
- **Bulk Selection:** Introduced a master checkbox in the pane headers for intuitive "Select All" functionality, complete with indeterminate state handling.
- **Interactive File Sorting:** Implemented 2-tier column headers supporting instant ascending/descending sorts for Name, Modified, and Size with dynamic responsive layouts.

### Changed
- **Internal Modularization & Refactoring:** Restructured backend and frontend codebases into dedicated subsystems (`app/transfers/`, `app/browse/`, `static/js/modals/`, ES modules) with isolated concerns and focused test coverage.

### Fixed
- **Transfer Queue UI Transitions:** Resolved an issue where queued operations failed to dynamically render active controls upon state shifts.
- **UI & State:** Resolved action button visibility loss when toggling pause/resume on active transfers.
- **Uploads:** Automated cleanup of completed upload toast notifications.
- **Mobile UX:** Streamlined vertical padding and element alignment within the mobile transfer dialog.
- **Modals:** Improved text visibility and wrapping for long file paths and filenames in transfer and cancellation dialogs, including native hover tooltips.
- **Transfer Picker:** Simplified the destination browser UI by dynamically hiding non-essential metadata (dates, sizes), eliminating truncation and maximizing real estate for long folder names.
- **Destination Picker Fallback & Stability:** Automatically fallback to root and clear stale stored destinations on 404 errors when opening the destination picker; improved missing parent directory handling to prevent unhandled promise rejections.
