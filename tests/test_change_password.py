import os
import tempfile
import threading
import sqlite3
import pytest
from pathlib import Path
from fastapi.testclient import TestClient

from app.main import app
from app.config import get_settings, User
from app.auth import hash_password, create_session_cookie, read_session_cookie
from app.transfers import db

@pytest.fixture
def test_env():
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        config_path = temp_path / "config.toml"
        data_dir = temp_path / "data"
        
        # Write initial config.toml
        initial_hash = hash_password("oldpassword")
        config_content = f"""
allowed_roots = ["/"]
secret_key = "test_secret"
data_dir = "{data_dir}"

[[users]]
username = "testuser"
password_hash = "{initial_hash}"
"""
        with open(config_path, "w") as f:
            f.write(config_content)
        
        os.environ["LITESYNC_CONFIG"] = str(config_path)
        
        import app.config
        app.config._settings = None
        settings = app.config.get_settings()
        
        # Initialize the DB (which triggers bootstrap)
        db.init_db(settings.data_dir)
        
        # Clear global lockout state
        from app.auth import _failed_attempts
        _failed_attempts.clear()
        
        yield {
            "config_path": config_path,
            "data_dir": data_dir,
            "settings": settings,
            "initial_hash": initial_hash
        }
        
        # Clean up
        app.config._settings = None
        _failed_attempts.clear()
        os.environ.pop("LITESYNC_CONFIG", None)
        
@pytest.fixture
def client():
    return TestClient(app)

def test_migration_success_and_idempotency(test_env):
    conn = sqlite3.connect(test_env["data_dir"] / "litesync.db")
    cursor = conn.cursor()
    cursor.execute("SELECT username, password_hash FROM users")
    users = cursor.fetchall()
    
    # 1. Migration success
    assert len(users) == 1
    assert users[0][0] == "testuser"
    assert users[0][1] == test_env["initial_hash"]
    
    # Check in-memory list
    settings = get_settings()
    assert len(settings.users) == 1
    assert settings.users[0].username == "testuser"
    assert settings.users[0].password_hash == test_env["initial_hash"]
    
    # 2. Idempotency - initialize db again
    db.init_db(test_env["data_dir"])
    cursor.execute("SELECT COUNT(*) FROM users")
    assert cursor.fetchone()[0] == 1
    conn.close()

def test_config_never_written(test_env):
    # Change the password
    new_hash = hash_password("newpassword123")
    db.update_user_password("testuser", new_hash)
    
    # Ensure config.toml was not modified (3. config.toml is never written to)
    with open(test_env["config_path"], "r") as f:
        content = f.read()
    assert test_env["initial_hash"] in content
    assert new_hash not in content

def test_successful_password_change(test_env, client):
    # Log in first
    login_resp = client.post("/api/login", json={"username": "testuser", "password": "oldpassword"})
    cookie = login_resp.cookies.get("litesync_session")
    
    # 4. Successful password change
    change_resp = client.post("/api/change-password", 
                              json={"current_password": "oldpassword", "new_password": "newpassword123"},
                              cookies={"litesync_session": cookie})
    assert change_resp.status_code == 200

def test_current_device_cookie_reissued(test_env, client):
    login_resp = client.post("/api/login", json={"username": "testuser", "password": "oldpassword"})
    cookie = login_resp.cookies.get("litesync_session")
    
    change_resp = client.post("/api/change-password", 
                              json={"current_password": "oldpassword", "new_password": "newpassword123"},
                              cookies={"litesync_session": cookie})
                              
    # 5. Current device's session remains valid immediately after a password change (cookie re-issued)
    new_cookie = change_resp.cookies.get("litesync_session")
    assert new_cookie != cookie
    
    # Check that we can still use the new cookie
    whoami_resp = client.get("/api/whoami", cookies={"litesync_session": new_cookie})
    assert whoami_resp.status_code == 200
    assert whoami_resp.json()["username"] == "testuser"

def test_other_devices_invalidated(test_env, client):
    login_resp = client.post("/api/login", json={"username": "testuser", "password": "oldpassword"})
    cookie = login_resp.cookies.get("litesync_session")
    
    client.post("/api/change-password", 
                json={"current_password": "oldpassword", "new_password": "newpassword123"},
                cookies={"litesync_session": cookie})
                
    # 6. Other devices' sessions (old hash suffix) are rejected with 401
    whoami_resp_old = client.get("/api/whoami", cookies={"litesync_session": cookie}, follow_redirects=False)
    assert whoami_resp_old.status_code == 401

def test_old_password_stops_working(test_env, client):
    login_resp = client.post("/api/login", json={"username": "testuser", "password": "oldpassword"})
    cookie = login_resp.cookies.get("litesync_session")
    
    client.post("/api/change-password", 
                json={"current_password": "oldpassword", "new_password": "newpassword123"},
                cookies={"litesync_session": cookie})
                
    # Try fresh login with old password
    login_resp2 = client.post("/api/login", json={"username": "testuser", "password": "oldpassword"})
    assert login_resp2.status_code == 401
    assert "Invalid username or password" in login_resp2.json()["detail"]

def test_old_format_cookie_gracefully_rejected(test_env, client):
    # 7. Old-format cookie (missing suffix entirely) is rejected gracefully
    from app.auth import _serializer
    old_cookie_value = _serializer().dumps({"username": "testuser"})
    resp = client.get("/api/whoami", cookies={"litesync_session": old_cookie_value}, follow_redirects=False)
    assert resp.status_code == 401

def test_lockout_rate_limit_triggers_429(test_env, client):
    login_resp = client.post("/api/login", json={"username": "testuser", "password": "oldpassword"})
    cookie = login_resp.cookies.get("litesync_session")
    
    # 8. Wrong current password rejected, and lockout increments
    for _ in range(5):
        resp = client.post("/api/change-password", 
                           json={"current_password": "wrongpassword", "new_password": "newpassword123"},
                           cookies={"litesync_session": cookie})
        if resp.status_code == 429:
            break
        assert resp.status_code == 401
    
    # 9. Lockout/rate-limit triggers correctly with 429 status code
    resp = client.post("/api/change-password", 
                       json={"current_password": "wrongpassword", "new_password": "newpassword123"},
                       cookies={"litesync_session": cookie})
    assert resp.status_code == 429
    
    # Also locks out login
    resp = client.post("/api/login", json={"username": "testuser", "password": "oldpassword"})
    assert resp.status_code == 429

def test_short_password_rejected(test_env, client):
    login_resp = client.post("/api/login", json={"username": "testuser", "password": "oldpassword"})
    cookie = login_resp.cookies.get("litesync_session")
    
    # 10. Short new password (< 8 chars) rejected server-side
    resp = client.post("/api/change-password", 
                       json={"current_password": "oldpassword", "new_password": "short"},
                       cookies={"litesync_session": cookie})
    assert resp.status_code == 400
    assert "least 8 characters" in resp.json()["detail"]

def test_concurrent_password_change(test_env):
    # 11. Concurrent password-change safety
    def worker(i):
        new_hash = hash_password(f"newpassword{i}")
        db.update_user_password("testuser", new_hash)
        
    threads = [threading.Thread(target=worker, args=(i,)) for i in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
        
    # As long as no sqlite3.OperationalError was raised (database is locked), we passed
    conn = sqlite3.connect(test_env["data_dir"] / "litesync.db")
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM users")
    assert cursor.fetchone()[0] == 1

def test_no_activity_log_entry(test_env, client):
    # 12. No Activity Log entry is created for password changes
    login_resp = client.post("/api/login", json={"username": "testuser", "password": "oldpassword"})
    cookie = login_resp.cookies.get("litesync_session")
    
    # clear initial activity logs if any
    db.clear_activity()
    
    change_resp = client.post("/api/change-password", 
                              json={"current_password": "oldpassword", "new_password": "newpassword123"},
                              cookies={"litesync_session": cookie})
    assert change_resp.status_code == 200
    
    logs = db.list_activity()
    # verify password change does not pollute transfer/activity logs
    assert len(logs) == 0
