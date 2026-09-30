# Third-party notices

## RustFS

- Project: https://github.com/rustfs/rustfs
- Version used: 1.0.0
- Image: `rustfs/rustfs:1.0.0@sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff`
- License: Apache License, Version 2.0
- License text: https://github.com/rustfs/rustfs/blob/1.0.0/LICENSE
- Security policy: https://github.com/rustfs/rustfs/blob/1.0.0/SECURITY.md

The image inspected on 2026-09-30 does not contain a `LICENSE` or `NOTICE` file. The tag `1.0.0` in the upstream repository is Apache-2.0 and has no `NOTICE` file.

Apache-2.0 obligations that apply when this software is distributed: keep the license text and copyright notices, state significant modifications, and retain attribution notices from the upstream project. This file records the license. It is not a statement that distribution has no remaining legal obligation.

## SeaweedFS

SeaweedFS 4.48 was evaluated and not selected. Its upstream license is Apache-2.0: https://github.com/seaweedfs/seaweedfs/blob/4.48/LICENSE. It is not part of the running compose.

## MinIO

The MinIO server image is not part of the active compose or the release pin. Existing named volumes that once belonged to MinIO are retained and are not mounted. MinIO's AGPLv3 terms are not accepted for the active object-storage component by this change.
