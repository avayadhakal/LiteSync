import pytest
from tests.test_conflict_resolution import temp_roots, override_auth, test_client
from app.config import get_settings

def test_debug(temp_roots, test_client):
    root1, root2 = temp_roots
    print(f"root2 is {root2}")
    print(f"allowed roots: {get_settings().allowed_roots}")
