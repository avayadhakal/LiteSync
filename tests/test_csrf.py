import pytest
from unittest.mock import patch, MagicMock
from fastapi.testclient import TestClient
from app.main import app
from app.config import get_settings

client = TestClient(app)

@pytest.fixture
def mock_settings():
    settings = get_settings()
    with patch("app.main.get_settings") as mock_get_settings, patch("app.config.get_settings") as mock_config_get:
        mock_get_settings.return_value = settings
        mock_config_get.return_value = settings
        yield mock_get_settings

def test_csrf_origin_mismatch():
    response = client.post("/api/login", json={"username": "admin", "password": "password"}, headers={"Origin": "http://evil.com"})
    assert response.status_code == 403
    assert "CSRF" in response.text

def test_csrf_origin_missing():
    # If no origin or referer
    response = client.post("/api/login", json={"username": "admin", "password": "password"})
    assert response.status_code == 403
    assert "CSRF" in response.text

def test_csrf_origin_match():
    # Use default allowed_origin for 0.0.0.0 bind which is http://localhost:8000
    response = client.post("/api/login", json={"username": "admin", "password": "password"}, headers={"Origin": "http://localhost:8000"})
    assert response.status_code != 403

def test_csrf_referer_match():
    response = client.post("/api/login", json={"username": "admin", "password": "password"}, headers={"Referer": "http://localhost:8000/index.html"})
    assert response.status_code != 403

def test_csrf_get_not_blocked():
    # GET shouldn't be blocked even if missing origin
    response = client.get("/api/whoami")
    # It might return 401 unauth, but not 403 CSRF
    assert response.status_code != 403

def test_csrf_authorization_header_exemption():
    # With Authorization header, origin check is bypassed
    response = client.post("/api/login", json={"username": "admin", "password": "password"}, headers={"Origin": "http://evil.com", "Authorization": "Basic YWRtaW46cGFzc3dvcmQ="})
    # Since login endpoint doesn't actually use Authorization, we are testing the middleware exemption
    assert response.status_code != 403

def test_wildcard_host_lan_ip_allowed(mock_settings):
    import dataclasses
    from app.config import get_settings as actual_get_settings
    orig = actual_get_settings()
    # Explicitly configure a wildcard without allowed_origins
    new_settings = dataclasses.replace(orig, host="0.0.0.0", port=8000, allowed_origins=[])
    # the old code actually had allowed_origins populated in __post_init__.
    # To truly simulate the old code, we should simulate what __post_init__ did.
    # Wait, __post_init__ is called when we construct a Settings object or when we use dataclasses.replace?
    # dataclasses.replace doesn't call __post_init__.
    # Let's just create a Settings object directly.
    from app.config import Settings
    
    s = Settings(
        allowed_roots=orig.allowed_roots,
        users=orig.users,
        secret_key=orig.secret_key,
        session_max_age=orig.session_max_age,
        secure_cookie=orig.secure_cookie,
        data_dir=orig.data_dir,
        host="0.0.0.0",
        port=8000
    )
    mock_settings.return_value = s
    
    res = client.post("/api/login", headers={"Origin": "http://192.168.30.109:8000"})
    assert res.status_code != 403, f"Expected non-403, got {res.status_code} {res.text}"

def test_wildcard_host_wrong_scheme_rejected(mock_settings):
    from app.config import Settings
    from app.config import get_settings as actual_get_settings
    orig = actual_get_settings()
    s = Settings(
        allowed_roots=orig.allowed_roots,
        users=orig.users,
        secret_key=orig.secret_key,
        session_max_age=orig.session_max_age,
        secure_cookie=orig.secure_cookie,
        data_dir=orig.data_dir,
        host="0.0.0.0",
        port=8000
    )
    mock_settings.return_value = s
    
    res = client.post("/api/login", headers={"Origin": "https://192.168.30.109:8000"})
    assert res.status_code == 403
    assert "CSRF" in res.text

def test_wildcard_host_wrong_port_rejected(mock_settings):
    from app.config import Settings
    from app.config import get_settings as actual_get_settings
    orig = actual_get_settings()
    s = Settings(
        allowed_roots=orig.allowed_roots,
        users=orig.users,
        secret_key=orig.secret_key,
        session_max_age=orig.session_max_age,
        secure_cookie=orig.secure_cookie,
        data_dir=orig.data_dir,
        host="0.0.0.0",
        port=8000
    )
    mock_settings.return_value = s
    
    res = client.post("/api/login", headers={"Origin": "http://192.168.30.109:9000"})
    assert res.status_code == 403
    assert "CSRF" in res.text

def test_non_wildcard_host_regression(mock_settings):
    from app.config import Settings
    from app.config import get_settings as actual_get_settings
    orig = actual_get_settings()
    s = Settings(
        allowed_roots=orig.allowed_roots,
        users=orig.users,
        secret_key=orig.secret_key,
        session_max_age=orig.session_max_age,
        secure_cookie=orig.secure_cookie,
        data_dir=orig.data_dir,
        host="192.168.30.109",
        port=8000
    )
    mock_settings.return_value = s
    
    res = client.post("/api/login", headers={"Origin": "http://192.168.30.109:8000"})
    assert res.status_code != 403

def test_explicit_allowed_origins_precedence(mock_settings):
    from app.config import Settings
    from app.config import get_settings as actual_get_settings
    orig = actual_get_settings()
    s = Settings(
        allowed_roots=orig.allowed_roots,
        users=orig.users,
        secret_key=orig.secret_key,
        session_max_age=orig.session_max_age,
        secure_cookie=orig.secure_cookie,
        data_dir=orig.data_dir,
        host="0.0.0.0",
        port=8000,
        allowed_origins=["http://my-custom-domain.com"]
    )
    mock_settings.return_value = s
    
    # Custom domain should be allowed
    res1 = client.post("/api/login", headers={"Origin": "http://my-custom-domain.com"})
    assert res1.status_code != 403
    
    # LAN IP matching scheme and port should be REJECTED because allowed_origins is explicit
    res2 = client.post("/api/login", headers={"Origin": "http://192.168.30.109:8000"})
    assert res2.status_code == 403
