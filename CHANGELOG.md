# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]
### Added
- **Transfer Engine:** Robust background processing utilizing `rsync` or zero-copy `os.copy_file_range` kernel transfers.
- **Direct Uploads:** Streamed multipart browser uploads straight to disk, circumventing memory exhaustion.
- **Downloads:** Secure file downloads via signed URLs supporting HTTP Range requests.
- **Recursive Selection:** Intelligent hierarchical selection model allowing arbitrary sub-item exclusions.
- **Activity Log:** SQLite-backed persistent real-time activity tracking and toast notification system.
- **Mobile UX:** Fully responsive dual/single pane layout dynamically adapting to mobile viewports.
- **Transfer Controls:** Pause and resume active background `rsync` transfers natively.
- **Conflict Resolution:** Safely skip, keep both, or replace existing files during transfers with pre-flight resolution.
- **Bulk Selection:** Introduced a master checkbox in the pane headers for intuitive "Select All" functionality, complete with indeterminate state handling.

### Fixed
- **UI & State:** Resolved action button visibility loss when toggling pause/resume on active transfers.
- **Uploads:** Automated cleanup of completed upload toast notifications.
- **Mobile UX:** Streamlined vertical padding and element alignment within the mobile transfer dialog.
- **Modals:** Improved text visibility and wrapping for long file paths and filenames in transfer and cancellation dialogs, including native hover tooltips.
