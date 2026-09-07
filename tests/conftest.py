import pytest
import starlette.testclient
import fastapi.testclient
from app.config import get_settings

OriginalTestClient = starlette.testclient.TestClient

class CustomTestClient(OriginalTestClient):
    def request(self, method, url, **kwargs):
        headers = kwargs.get("headers", {})
        if headers is None:
            headers = {}
        elif not isinstance(headers, dict):
            headers = dict(headers)
            
        if method.upper() in ("POST", "PUT", "DELETE", "PATCH"):
            import inspect
            frame = inspect.currentframe()
            is_csrf_test = False
            while frame:
                if frame.f_code.co_name.startswith("test_csrf_"):
                    is_csrf_test = True
                    break
                frame = frame.f_back
                
            if not is_csrf_test and "origin" not in {k.lower() for k in headers.keys()}:
                settings = get_settings()
                if settings and settings.allowed_origins:
                    headers["Origin"] = settings.allowed_origins[0]
                else:
                    headers["Origin"] = "http://127.0.0.1:8000"
                
        kwargs["headers"] = headers
        return super().request(method, url, **kwargs)

starlette.testclient.TestClient = CustomTestClient
fastapi.testclient.TestClient = CustomTestClient
