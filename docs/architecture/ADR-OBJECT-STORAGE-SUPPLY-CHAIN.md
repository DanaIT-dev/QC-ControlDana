# ADR: Object storage supply chain

Status: RustFS remains a release block and is not used for the internal pilot. Date: 2026-10-01.

Pilot decision: development, test, staging, and production compose use official SeaweedFS 4.48, digest `sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d`. The S3 adapter is unchanged. Existing attachment rows were zero, so no user-file copy was required. The RustFS volume stays on disk and is not mounted. Production compose does not publish object storage. Production readiness stays blocked.

## Context

QC Control stores attachments in RustFS 1.0.0. The official container tag `1.0.0` points at commit `d47f54bfb2f39f48bd1adda334bd27e151fe85b8`. The GitHub tag is unsigned. The published SLSA statement covers zip, rpm, and deb assets and does not name the container manifest digest `sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff` or the `linux/amd64` digest `sha256:ba0a1b53e36f321c0d46f3867104abef169f7bc59c467c664ddac87e7ddc9a8b`. Trivy sees Alpine packages in that image and no Rust crates. A source tag is not proof that the running binary was built from that commit.

## Why the official binary is not enough

The product cannot treat `rustfs/rustfs:1.0.0` as a verified build artifact. An operator can read the tag and the image digest, and those two facts stay unconnected. A later rebuild of the same tag could ship different bytes. The container SBOM does not list the crates that `cargo audit` sees in the source tree.

## Advisory RUSTSEC-2023-0071

The source lockfile contains `rsa` 0.9.10 and `rsa` 0.10.0-rc.18. No patched release exists. The direct edges are:

```text
rustfs binary
  -> rustfs-crypto
    -> rsa 0.10.0-rc.18, feature sha2
  -> rustfs-iam
    -> openidconnect
      -> rsa 0.9.10
```

`cargo tree -i rsa@0.10.0-rc.18` on that commit lists `rustfs` and `rustfs-crypto` as parents. `cargo tree -e features -i rsa@0.10.0-rc.18` shows feature `default` active through `rustfs` feature `default` (`ftps`, `webdav`, `gcs`) and through `rustfs-crypto` feature `crypto`. `cargo tree -i rsa@0.9.10` lists `openidconnect` → `rustfs-iam` → `rustfs`. `crates/crypto/Cargo.toml` depends on `rsa` directly. `crates/crypto/src/license_token.rs` function `parse` loads an RSA private key and calls `RsaPrivateKey::decrypt` with `Pkcs1v15Encrypt`. That is the Marvin timing path named by the advisory. The same module signs licenses with `BlindedSigningKey` and verifies them with a public key. `rustfs/src/license.rs` calls `parse_license_with_public_key` when `RUSTFS_LICENSE` is non-empty. QC Compose does not set that variable, so startup records a missing license and returns before verification. That configuration does not remove the function from the crate, does not prove the official binary omitted it, and is not a `not_affected` justification.

STS, KMS, and JWT code in the same tree use other crates for their own operations. They do not replace this `rsa` edge. The crypto and IAM crates are ordinary dependencies of the `rustfs` package, not optional features of the default binary (`default = ["ftps", "webdav", "gcs"]`). Removing `rsa` requires a source change. An internal image built from the unchanged lockfile would still compile the same crate.

## Decision

Do not publish a signed release candidate from this commit. Do not mark the advisory `NOT_AFFECTED`. Do not start an internal image build as if it closed the advisory. Keep the official digest for development and for the existing S3 contract. Production publication stays blocked until a named human owner either accepts the advisory or a maintained build demonstrably drops the vulnerable private-key path without changing S3 behavior.

## Internal build, if it is attempted later

A later build may use tag `1.0.0` only after confirming that the tag still resolves to `d47f54bfb2f39f48bd1adda334bd27e151fe85b8`. It must run on native GitHub-hosted `linux/amd64`, with a pinned Rust toolchain, `cargo build --locked`, an unchanged `Cargo.lock`, no unpinned git dependency, a non-root runtime, `cargo auditable` or an equivalent crate inventory, a CycloneDX SBOM bound to the image digest, OCI labels for the upstream commit and the QC commit, SLSA-compatible provenance, and a Cosign keyless signature checked by a separate job. `cargo audit`, `cargo deny`, Trivy, Gitleaks, and the S3 contract are required. That build does not clear RUSTSEC-2023-0071 while `rsa` remains reachable.

## Cost of a fork or an internal build

QC would own toolchain updates, CVE triage, and image rebuilds for every upstream RustFS release. The storage service is not the product's own code, so each upstream commit needs a repeated S3 contract run before it can replace the running digest. A fork that deletes license RSA code adds a permanent patch to rebase.

## Upstream update

1. Confirm the new tag commit.
2. Repeat `cargo tree -i rsa`, `cargo tree -e features`, `cargo audit`, and `cargo deny check`.
3. Rebuild only when the advisory is gone or a named owner has accepted it.
4. Run the S3 contract against the new digest.
5. Replace the pinned digest in Compose and the supply-chain record together.

## Emergency rollback

Keep the previous immutable digest in `infra/docker/image-pins.json`. Rollback is a Compose change back to that digest, then a restart of `object-storage`. Do not delete the RustFS volume. Do not point the service at the legacy MinIO volume.

## Return to the official image

The official image can become the production artifact when upstream publishes a signed provenance statement that lists the exact `linux/amd64` manifest digest, the digest matches the image QC pulls, and `cargo audit` on the correlated lockfile has no unhandled applicable advisory.

## SeaweedFS

SeaweedFS remains a fallback candidate. This ADR does not switch the product to it. A switch needs a full S3 contract, a migration plan for existing objects, and a separate decision.
