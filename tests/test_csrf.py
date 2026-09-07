import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.config import get_settings

client = TestClient(app)

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

