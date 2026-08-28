import os
import tempfile
import unittest
from dataclasses import FrozenInstanceError
from pathlib import Path

from app.config import Settings, User, get_settings, load_settings


class TestConfig(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.config_dir = Path(self.temp_dir.name)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_load_valid_config(self):
        config_content = """
allowed_roots = ["/mnt/share", "/home/user/downloads"]
secret_key = "test_secret_key_123"
session_max_age = 3600
secure_cookie = true
data_dir = "/var/lib/litesync"
host = "127.0.0.1"
port = 9000

[[users]]
username = "admin"
password_hash = "$2b$12$somehash"

[[users]]
username = "guest"
password_hash = "$2b$12$anotherhash"
"""
        config_path = self.config_dir / "config.toml"
        config_path.write_text(config_content)

        settings = load_settings(config_path)

        self.assertEqual(len(settings.allowed_roots), 2)
        self.assertEqual(settings.allowed_roots[0], Path("/mnt/share").resolve())
        self.assertEqual(settings.allowed_roots[1], Path("/home/user/downloads").resolve())
        self.assertEqual(settings.secret_key, "test_secret_key_123")
        self.assertEqual(settings.session_max_age, 3600)
        self.assertTrue(settings.secure_cookie)
        self.assertEqual(settings.data_dir, Path("/var/lib/litesync").resolve())
        self.assertEqual(settings.host, "127.0.0.1")
        self.assertEqual(settings.port, 9000)

        self.assertEqual(len(settings.users), 2)
        user1 = settings.find_user("admin")
        self.assertIsNotNone(user1)
        self.assertEqual(user1.username, "admin")
        self.assertEqual(user1.password_hash, "$2b$12$somehash")

        user2 = settings.find_user("guest")
        self.assertIsNotNone(user2)
        self.assertEqual(user2.username, "guest")

        self.assertIsNone(settings.find_user("nonexistent"))

    def test_load_config_defaults(self):
        config_content = """
allowed_roots = ["/mnt/data"]
secret_key = "minimal_secret"

[[users]]
username = "pi"
password_hash = "$2b$12$pihash"
"""
        config_path = self.config_dir / "minimal.toml"
        config_path.write_text(config_content)

        settings = load_settings(config_path)

        self.assertEqual(settings.session_max_age, 604800)
        self.assertFalse(settings.secure_cookie)
        self.assertEqual(settings.data_dir, Path("./data").resolve())
        self.assertEqual(settings.host, "0.0.0.0")
        self.assertEqual(settings.port, 8000)

    def test_missing_config_file(self):
        non_existent = self.config_dir / "does_not_exist.toml"
        with self.assertRaises(FileNotFoundError) as ctx:
            load_settings(non_existent)
        self.assertIn("Config file not found", str(ctx.exception))
        self.assertIn("config.example.toml", str(ctx.exception))

    def test_settings_immutability(self):
        config_content = """
allowed_roots = ["/mnt/data"]
secret_key = "minimal_secret"

[[users]]
username = "pi"
password_hash = "$2b$12$pihash"
"""
        config_path = self.config_dir / "immutable.toml"
        config_path.write_text(config_content)
        settings = load_settings(config_path)

        with self.assertRaises(FrozenInstanceError):
            settings.secret_key = "changed"  # type: ignore

        user = settings.users[0]
        with self.assertRaises(FrozenInstanceError):
            user.username = "changed"  # type: ignore

    def test_env_var_config_path(self):
        config_content = """
allowed_roots = ["/mnt/env_data"]
secret_key = "env_secret"

[[users]]
username = "env_user"
password_hash = "$2b$12$envhash"
"""
        config_path = self.config_dir / "env_config.toml"
        config_path.write_text(config_content)

        old_env = os.environ.get("LITESYNC_CONFIG")
        try:
            os.environ["LITESYNC_CONFIG"] = str(config_path)
            settings = load_settings()
            self.assertEqual(settings.secret_key, "env_secret")
            self.assertEqual(settings.allowed_roots[0], Path("/mnt/env_data").resolve())
        finally:
            if old_env is not None:
                os.environ["LITESYNC_CONFIG"] = old_env
            else:
                os.environ.pop("LITESYNC_CONFIG", None)

    def test_download_signing_key_derivation(self):
        from app.config import get_download_signing_key
        config_content = """
allowed_roots = ["/mnt/data"]
secret_key = "my_master_secret"
"""
        config_path = self.config_dir / "derive_test.toml"
        config_path.write_text(config_content)
        settings = load_settings(config_path)

        key1 = get_download_signing_key(settings)
        self.assertIsInstance(key1, bytes)
        self.assertEqual(len(key1), 32)
        # Verify it is not equal to raw secret_key
        self.assertNotEqual(key1, b"my_master_secret")
        # Verify deterministic
        self.assertEqual(key1, get_download_signing_key(settings))

    def test_custom_download_secret_key(self):
        from app.config import get_download_signing_key
        config_content = """
allowed_roots = ["/mnt/data"]
secret_key = "my_master_secret"
download_secret_key = "custom_download_secret"
download_expiry = 3600
"""
        config_path = self.config_dir / "custom_secret_test.toml"
        config_path.write_text(config_content)
        settings = load_settings(config_path)

        self.assertEqual(settings.download_expiry, 3600)
        self.assertEqual(settings.download_secret_key, "custom_download_secret")
        key = get_download_signing_key(settings)
        self.assertEqual(key, b"custom_download_secret")


if __name__ == "__main__":
    unittest.main()
