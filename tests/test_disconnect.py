import pytest
from tests.transfers.test_conflict_resolution import temp_roots, override_auth, test_client
from starlette.requests import ClientDisconnect
from unittest.mock import patch

def test_upload_overwrite_mid_stream_disconnect(temp_roots, test_client):
    root1, root2 = temp_roots
    dest = root2 / "dest"
    dest.mkdir()
    target_file = dest / "file.txt"
    target_file.write_text("original content")

    async def mock_read(self, size=-1):
        raise ClientDisconnect()

    with patch("app.routes_browse.UploadFile.read", new=mock_read):
        response = test_client.post(
            "/api/upload",
            data={"path": str(dest), "on_conflict": "overwrite"},
            files={"files": ("file.txt", b"new content", "text/plain")}
        )
    assert response.status_code == 499
    
    assert target_file.exists()
    assert target_file.read_text() == "original content"
