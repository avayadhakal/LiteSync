# Use the official Python slim image matching our environment (3.14)
FROM python:3.14-slim

# Install system dependencies (rsync is required for syncing files)
RUN apt-get update && \
    apt-get install -y --no-install-recommends rsync && \
    rm -rf /var/lib/apt/lists/*

# Create a dedicated non-root user
RUN groupadd -r litesync && useradd -r -g litesync -m -d /app litesync

# Set the working directory
WORKDIR /app

# Copy application code and configuration template
COPY requirements.txt config.example.toml ./
COPY app ./app
COPY static ./static

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Ensure the /data directory exists and belongs to the litesync user
RUN mkdir -p /data && chown -R litesync:litesync /data /app && chmod 755 /app

# Switch to the non-root user
USER litesync

# Expose the application port
EXPOSE 8000

# Set environment variables for the container
ENV LITESYNC_CONFIG=/data/config.toml
ENV TMPDIR=/data/tmp

# Define the healthcheck hitting the API to ensure the FastAPI app and routing are up
# We accept both 200 (OK) and 401 (Unauthorized) as healthy, since a 401 proves the app logic is running.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request, urllib.error, sys; \
try: \
    urllib.request.urlopen('http://127.0.0.1:8000/api/whoami'); \
    sys.exit(0); \
except urllib.error.HTTPError as e: \
    sys.exit(0) if e.code in (200, 401) else sys.exit(1); \
except Exception: \
    sys.exit(1);" || exit 1

# Start the application exactly like the systemd service does
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
