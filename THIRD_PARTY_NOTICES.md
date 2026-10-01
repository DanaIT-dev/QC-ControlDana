# Third-party notices

## SeaweedFS

- Project: https://github.com/seaweedfs/seaweedfs
- Version used: 4.48
- Image: `chrislusf/seaweedfs:4.48@sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`
- License: Apache License, Version 2.0
- License text: https://github.com/seaweedfs/seaweedfs/blob/4.48/LICENSE

Apache-2.0 obligations that apply when this software is distributed: keep the license text and copyright notices, state significant modifications, and retain attribution notices from the upstream project. This file records the license. It is not a statement that distribution has no remaining legal obligation.

## RustFS

RustFS 1.0.0 is not used by the development or staging compose. The previous evaluation remains in `docs/security/RUSTFS_SUPPLY_CHAIN.md`. Its volume is retained and is not mounted.

## MinIO

The MinIO server image is not part of the active compose or the release pin. Existing named volumes that once belonged to MinIO are retained and are not mounted. MinIO's AGPLv3 terms are not accepted for the active object-storage component by this change.
