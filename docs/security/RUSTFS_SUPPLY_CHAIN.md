# RustFS 1.0.0 supply chain

Checked 2026-09-30 against the pinned image.

```text
image:        docker.io/rustfs/rustfs:1.0.0
manifest:     sha256:8cc9801755448b71a786705ce76692c77e14936cccd87cf2fc31842e58f4d1ff
linux/amd64:  sha256:ba0a1b53e36f321c0d46f3867104abef169f7bc59c467c664ddac87e7ddc9a8b
linux/arm64:  sha256:42edb61d588775f9431ff436216d14392d2234d4eb2ed68321569fbf7245b36b
```

## Provenance classification

`SOURCE_TAG_ONLY`

The annotated Git tag `1.0.0` points at one commit, `d47f54bfb2f39f48bd1adda334bd27e151fe85b8`. GitHub reports the tag signature as unsigned. The image config repeats that revision in a concatenated label string. An unsigned SLSA statement is attached to the GitHub release and covers the zip, rpm, and deb assets from workflow `rustfs/rustfs/.github/workflows/build.yml`. That statement does not list the container manifest digest or the `linux/amd64` platform digest.

This review does not claim that the official container binary was built from that commit. The container is not marked CVE-free. Trivy 0.66.0 reported no OS CRITICAL or HIGH finding and did not inventory the static Rust crates.

An internal rebuild was not started. It would move operational ownership of the storage image onto this repository and needs a separate architecture decision.

## Source audit

The source tree was cloned outside the product repository at the tag commit. `Cargo.lock` is present. `cargo metadata --locked`, `cargo audit` 0.22.2, and `cargo deny` 0.20.2 ran with Rust 1.98.1 on 2026-09-30. The results describe the source graph, not the identity of the published container.

```text
packages: 1092
crates.io: 1041
workspace/local: 51
git dependencies: 0
path dependencies outside the workspace: 0
licenses: cargo deny ok
sources: cargo deny ok
bans: cargo deny ok
```

`cargo audit` reported one vulnerability twice, once for each locked `rsa` version:

```text
RUSTSEC-2023-0071
package: rsa
title: Marvin Attack: potential key recovery through timing sidechannels
patched versions: none
```

Upstream `deny.toml` already ignores that advisory and describes it as transitive through OpenID Connect, with no fixed crate. QC compose does not enable an OpenID provider. The vulnerable code is APPLICABLE to the source graph and UNKNOWN inside the published container binary, because the container digest is not correlated to this lockfile.

`cargo audit` also warned that `faster-hex` 0.10.0 and `lru` 0.16.4 are unsound. Those warnings are not vulnerability advisories. `cargo deny check advisories` exited non-zero; its detailed diagnostic was not retained separately from the audit JSON above.

The upstream CycloneDX SBOM for tag 1.0.0 lists 1150 libraries and names the application `rustfs` 1.0.0. It does not mention the container manifest digest. The container SBOM produced by Trivy lists Alpine packages and no Rust crates.

## CI preflight

A 1800-second disposable run on the local aarch64 host finished on 2026-09-30. It is not native amd64 evidence and it is not the 24-hour staging soak. The runner kept at most 256 MiB of synthetic objects so the manifest comparison could finish. Checksum mismatches, missing objects, unexpected objects, orphan multipart uploads, corrupted objects, backup/restore mismatches, and unexplained failures were all 0. Two container restarts recovered in 6422 ms and 5375 ms. Operation latency was p50 7 ms, p95 119 ms, p99 161 ms. RustFS RSS rose to the 1 GiB cgroup limit during the run. After the runner deleted its prefix, the disposable volume was 191 MB.

An earlier unbounded run retained about 73 GB and was stopped before its manifest comparison finished. That volume was removed after the size was recorded. Staging soaks of 24 and 72 hours have not been run.

## Decision

QC keeps the official digest. Production mode treats the missing binary correlation as a blocker until upstream publishes a verifiable container provenance or an ADR accepts a locked internal build.
