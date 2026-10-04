# Nightly SQLite backup sidecar: sqlite3 baked in (no apk at runtime) and run as the engine's uid, not root.
FROM alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8
RUN apk add --no-cache sqlite && mkdir -p /data && chown 1000:1000 /data
COPY --chmod=755 backup.sh /usr/local/bin/backup.sh
USER 1000:1000
# Keeps BACKUP_KEEP_DAYS (default 3) nightly copies of each database. See backup.sh.
CMD ["/usr/local/bin/backup.sh"]
