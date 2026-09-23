# Contributing to LiteSync

Thank you for your interest in contributing to LiteSync! This document outlines how to set up your development environment, run the test suites, our architectural philosophy, and basic pull request expectations.

## Local Development Environment

To set up a local development environment, we recommend using the provided installation script or setting up a standard Python virtual environment.

1. **Install Python dependencies:**
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```
2. **Setup configuration:**
   Copy the example config and adjust as needed:
   ```bash
   cp config.example.toml config.toml
   ```
3. **Run the development server:**
   ```bash
   uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1 --reload
   ```

For a comprehensive installation (e.g. on Linux servers or Raspberry Pi), you can refer to the `install.sh` script which manages system services and user setups.

## Running the Test Suite

LiteSync has both a Python test suite (using pytest) and a Node-based JavaScript test suite for the frontend logic.

**Python Tests:**
```bash
pytest tests/test_version.py tests/test_change_password.py tests/test_config.py tests/test_csrf.py
```

**JavaScript Tests:**
Ensure you have Node.js installed, then run the frontend unit tests directly:
```bash
node tests/test_settings_version_frontend.js
node tests/test_scheduled_frontend.js
node tests/test_editor_frontend.js
node tests/test_selection.js
node tests/test_layout.js
node tests/test_filename_visibility.js
```

## Versioning & Release Workflow

LiteSync enforces a single source of truth for application versioning:

- **`VERSION` File:** The file `VERSION` at the repository root contains the canonical release version string (e.g. `0.1.0-beta`).
- **Zero Hardcoded Versions:** Never hardcode version strings in Python files, frontend JavaScript, HTML templates, or styles. The backend reads `VERSION` once at startup via `app/version.py` (with graceful fallback to `"dev"` if missing or unreadable), exposes it through `/api/version` and `/api/whoami`, and the frontend displays it dynamically in the About modal.
- **Releasing a New Version:**
  1. Update the version string in the root `VERSION` file (e.g. `0.2.0`).
  2. Commit the change:
     ```bash
     git add VERSION
     git commit -m "chore(release): bump version to 0.2.0"
     ```
  3. Create a matching git tag:
     ```bash
     git tag v0.2.0
     ```
  4. Push the commit and tags to the remote repository:
     ```bash
     git push origin main --tags
     ```
  5. Build and publish Docker images tagged with both the version and `:latest`:
     ```bash
     docker build -t avayadhakal/litesync:0.2.0 -t avayadhakal/litesync:latest .
     docker push avayadhakal/litesync:0.2.0
     docker push avayadhakal/litesync:latest
     ```

## Architectural Philosophy

LiteSync is designed as a minimal-overhead web app for local directory browsing and background file transfers across Linux platforms, homelabs, NAS servers, and single-board computers like the Raspberry Pi.
- **Python + FastAPI:** The backend uses FastAPI running on Uvicorn (with a single worker for state consistency).
- **Vanilla Frontend:** The UI is a Single-Page Application (SPA) built with pure HTML, CSS, and JS. No heavy frontend frameworks or build steps are required.
- **Dual Transfer Engine:** We support both a resilient `rsync` background worker and a fast native `os.copy_file_range` kernel-copy fallback.
- **Direct Streaming:** Browser uploads stream directly to the filesystem to prevent large files from exhausting system RAM.
- **Security:** Filesystem access is strictly bounded to admin-configured "allowed roots".

For more in-depth details, please read our [Architecture Document](docs/architecture.md).

## Pull Request Expectations

When submitting a pull request, please ensure you follow these basic expectations:
1. **Scope:** Keep changes scoped to a single feature, bugfix, or refactor. Avoid unrelated changes.
2. **Tests:** Run the full test suite (both Python and Node.js tests) before submitting your PR to ensure no regressions.
3. **Documentation:** If your change modifies system behavior, update `docs/architecture.md` and/or `README.md` as appropriate.
