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

Until that host exists, the status is `PERSISTENT_STAGING: BLOCKED_BY_MISSING_INFRASTRUCTURE`.
