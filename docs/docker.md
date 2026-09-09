# Docker Deployment Guide

LiteSync can be fully containerized using Docker and Docker Compose. This deployment method runs the application in isolation and manages its lifecycle automatically, serving as a parallel alternative to the systemd installation method.

## Getting Started

### 1. Prepare the Configuration

First, create a `config.toml` file for your container by copying the provided example:

```bash
cp config.example.toml config.toml
```

Edit `config.toml` and define your users and other settings. 

### 2. Configure Directory Mounts

Open `docker-compose.yml` and add volume bindings for any directories you want to sync.
Then, define the `LITESYNC_ALLOWED_ROOTS` environment variable to list those exact container-side paths. 

The format for volumes is `- /path/on/host:/path/in/container`. 
The format for `LITESYNC_ALLOWED_ROOTS` is a colon-separated list of the container paths (e.g., `/path/in/container1:/path/in/container2`).

**Example:**
If you want to sync files from your host's `/mnt/storage/movies` and `/home/user/downloads`, update your `docker-compose.yml` like this:

```yaml
    volumes:
      - litesync_data:/data
      - ./config.toml:/data/config.toml:ro
      # Map host directories to container paths
      - /mnt/storage/movies:/movies
      - /home/user/downloads:/downloads
    environment:
      # Tell LiteSync these paths are allowed (overrides config.toml)
      - LITESYNC_ALLOWED_ROOTS=/movies:/downloads
```

### 3. Start the Stack

With the configuration ready, start LiteSync in the background using Docker Compose:

```bash
docker compose up -d
```

You can check the logs to ensure it started properly:
```bash
docker compose logs -f
```

The container includes a built-in health check that probes the API, so `docker ps` will show the container as `healthy` once it's fully up and running.

## Multi-Architecture Builds (Docker Hub)

If you wish to build and push this image to a container registry (like Docker Hub) supporting both `linux/amd64` and `linux/arm64` architectures natively under a single tag, you can use Docker Buildx.

First, create a new buildx builder if you haven't already:
```bash
docker buildx create --use
```

Then build and push the multi-architecture image:
```bash
docker buildx build --platform linux/amd64,linux/arm64 -t yourusername/litesync:latest --push .
```
