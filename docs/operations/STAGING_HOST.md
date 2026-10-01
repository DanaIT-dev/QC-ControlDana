# Persistent staging host

No staging host is configured in this repository. Do not create a cloud VM, buy a server, or reuse production as part of release preparation.

Required host before the first persistent deployment:

```text
architecture: x86_64
OS: Ubuntu 24.04 LTS or a documented equivalent
CPU: at least 4 vCPU
RAM: at least 8 GB, 16 GB preferred
disk: at least 100 GB SSD
marker: /etc/sgr-staging-marker contains staging
environment: staging only
```

Isolation:

- a database volume that is not the development or production volume;
- a Redis volume of its own;
- a RustFS volume of its own;
- secrets that exist only in the GitHub `staging` environment;
- no production URL and no production credential;
- backup destination outside the staging host;
- the public interface is the reverse proxy;
- PostgreSQL, Redis, RustFS, and ClamAV publish no host port.

GitHub environment secrets, names only:

```text
STAGING_SSH_HOST
STAGING_SSH_USER
STAGING_SSH_KEY
```

Deploy uses `prisma migrate deploy` from the migrator image. Seed, reset, and production credentials are not part of this path.

Recommended capacity for the first persistent host:

```text
architecture: linux/amd64
CPU: 4 vCPU minimum, 8 vCPU for the 24-hour soak
RAM: 16 GB
disk: 200 GB SSD for the host, plus separate volumes below
```

Separate encrypted volumes:

- PostgreSQL data;
- Redis data;
- RustFS data, with a disk-usage alert before 80 percent full;
- ClamAV definitions;
- application logs, retained for 30 days.

DNS and TLS terminate on Caddy. The certificate name is the staging hostname. PostgreSQL, Redis, RustFS, and ClamAV stay on the Compose network and publish no host port. The firewall allows SSH from the operator network and HTTPS from the UAT network.

Compose is `infra/docker/compose.staging.yaml`. Secrets are injected by the GitHub `staging` environment. The repository stores only the secret names:

```text
STAGING_SSH_HOST
STAGING_SSH_USER
STAGING_SSH_KEY
```

Off-host backup is a copy of the PostgreSQL dump and the RustFS manifest to storage that is not the staging disk. A restore drill uses a disposable database and bucket on that host. Monitoring needs host disk, RustFS volume, API readiness, worker readiness, and backup success. Alerting goes to the operator channel. There is no alert destination in this repository.

The 24-hour soak runs only on this host, with its own `MAX_LIVE_OBJECTS`, `MAX_LIVE_BYTES`, `MAX_VOLUME_BYTES`, and `MIN_FREE_DISK_BYTES`. Rollback is the previous immutable image digest from `infra/docker/image-pins.json`, without deleting the data volumes.

UAT checklist, after the soak:

- login for ADMIN, MANAGER, SGR_MANAGER, RESPONSIBLE_ENGINEER, CONTRACTOR_ENGINEER, and SUPER_ADMIN;
- registry, act detail, and act creation;
- defect completion and reopen;
- attachment upload, download, and EICAR rejection;
- notification in the product UI;
- cancellation of an in-progress act;
- backup restore counts match;
- SUPER_ADMIN cannot mutate an act.

Until that host exists, the status is `PERSISTENT_STAGING: BLOCKED_BY_MISSING_INFRASTRUCTURE`. A disposable CI runner is not this host.
