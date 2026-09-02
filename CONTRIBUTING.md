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
pytest tests/
```

**JavaScript Tests:**
Ensure you have Node.js installed, then run the tests directly:
```bash
node tests/test_selection.js
node tests/test_layout.js
node tests/test_filename_visibility.js
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
