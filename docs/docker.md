# Docker Deployment Guide

LiteSync can be fully containerized using Docker and Docker Compose. This deployment method runs the application in isolation and manages its lifecycle automatically.

The published Docker image supports:

* `linux/amd64`
* `linux/arm64`

The target machine does not need Python, Git, or the LiteSync source code. You only need Docker and Docker Compose.

## Getting Started

### 1. Pull the Image

```bash
docker pull avayadhakal/litesync:latest
````

### 2. Create a Deployment Directory

```bash
mkdir -p ~/litesync/data
cd ~/litesync
```

### 3. Create `config.toml`

Create a file named `config.toml`:

```toml
allowed_roots = []

secret_key = "REPLACE_WITH_A_RANDOM_SECRET_KEY"

session_max_age = 604800
download_expiry = 86400
secure_cookie = false
data_dir = "/data"
host = "0.0.0.0"

[[users]]
username = "admin"
password_hash = "REPLACE_WITH_YOUR_BCRYPT_PASSWORD_HASH"
```

Generate a random secret key:

```bash
openssl rand -hex 32
```

Generate a password hash using the LiteSync image:

```bash
docker run --rm avayadhakal/litesync:latest \
  python -m app.auth hash "your-password"
```

Replace the generated values in `config.toml`.

> Keep `config.toml` private. It contains your LiteSync authentication credentials and secret key.

### 4. Create `docker-compose.yml`

Create a file named `docker-compose.yml`:

```yaml
services:
  litesync:
    image: avayadhakal/litesync:latest
    container_name: litesync
    restart: unless-stopped
    user: "1000:1000"

    ports:
      - "8000:8000"

    volumes:
      # LiteSync data
      - ./data:/data

      # Configuration
      - ./config.toml:/data/config.toml:ro

      # Host storage
      - /mnt/ssd:/mnt/ssd
      - /mnt/hdd2:/mnt/hdd2

    environment:
      # Max upload size in MB
      - LITESYNC_MAX_UPLOAD_SIZE_MB=10240

      # External web port
      - LITESYNC_PORT=8000

      # All allowed browse & sync directories
      - LITESYNC_ALLOWED_ROOTS=/mnt/ssd:/mnt/hdd2
```

Change the host storage paths to the directories you want LiteSync to access.

For example:

```yaml
volumes:
  - /home/user/downloads:/downloads
```

would make `/home/user/downloads` available inside the container as `/downloads`.

The corresponding allowed root would be:

```yaml
environment:
  - LITESYNC_ALLOWED_ROOTS=/downloads
```

> **Important:** The paths in `LITESYNC_ALLOWED_ROOTS` must be the paths inside the container, not the original host paths.

### 5. Start LiteSync

```bash
docker compose up -d
```

Check the container:

```bash
docker compose ps
```

View the logs:

```bash
docker compose logs -f
```

Once running, open:

```text
http://<server-ip>:8000/
```

Log in using the credentials configured in `config.toml`.

---

## Storage Permissions

The example Compose configuration runs LiteSync as:

```text
UID 1000
GID 1000
```

The directories mounted into the container must be accessible by that user.

For example:

```bash
sudo chown -R 1000:1000 /mnt/ssd
sudo chown -R 1000:1000 /mnt/hdd2
```

Use the permissions appropriate for your system rather than granting unnecessary access.

---

## Configuration

For Docker deployments, the following environment variables can be used:

* `LITESYNC_ALLOWED_ROOTS` — Colon-separated list of allowed directories
* `LITESYNC_PORT` — External web port used for CSRF validation
* `LITESYNC_ALLOWED_ORIGINS` — Comma-separated list of allowed browser origins
* `LITESYNC_MAX_UPLOAD_SIZE_MB` — Maximum upload size in MB

### Allowed Roots

LiteSync only has access to directories that are both:

1. Mounted into the container.
2. Listed in `LITESYNC_ALLOWED_ROOTS`.

For example:

```yaml
volumes:
  - /mnt/ssd:/storage
  - /mnt/hdd2:/backup

environment:
  - LITESYNC_ALLOWED_ROOTS=/storage:/backup
```

LiteSync can then access:

```text
/storage
/backup
```

but not arbitrary locations elsewhere in the container.

### Reverse Proxy

If LiteSync is placed behind a reverse proxy, set the allowed origin:

```yaml
environment:
  - LITESYNC_ALLOWED_ORIGINS=https://litesync.example.com
```

If LiteSync is accessed directly through port `8000`, this setting is normally not required.

---

## Updating

Whenever a newer image is published, update LiteSync with:

```bash
docker compose pull
docker compose up -d
```

Check the logs:

```bash
docker compose logs -f
```

Your configuration and application data remain outside the Docker image:

```text
config.toml
data/
```

---

## Useful Commands

### Start

```bash
docker compose up -d
```

### Stop

```bash
docker compose down
```

### Restart

```bash
docker compose restart
```

### Update

```bash
docker compose pull
docker compose up -d
```

### View Logs

```bash
docker compose logs -f
```

### Check Status

```bash
docker compose ps
```

---

## Docker Image

The published LiteSync image is:

```text
avayadhakal/litesync:latest
```

Pull it with:

```bash
docker pull avayadhakal/litesync:latest
```

Docker automatically selects the appropriate image architecture for supported systems:

```text
linux/amd64
linux/arm64
```

---

## Notes

### Configuration File

Make sure `config.toml` exists before starting the container:

```bash
docker compose up -d
```

The Compose file mounts it as:

```yaml
- ./config.toml:/data/config.toml:ro
```

### Application Data

LiteSync stores persistent application data under:

```text
./data
```

This includes the SQLite database and task data.

### Storage

Only directories explicitly mounted into the container and included in `LITESYNC_ALLOWED_ROOTS` are available to LiteSync.

### Minimal Deployment

A Docker deployment only requires:

```text
docker-compose.yml
config.toml
data/
```
