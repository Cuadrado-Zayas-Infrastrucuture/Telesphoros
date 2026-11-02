# Minimal application runtime: security scope

Date: 2026-11-01

The application only needs Node and its dynamically linked C/C++ libraries. Keeping the build distribution's installers, SUID utilities and unused libraries added attack paths unrelated to any hosted task. The final image is now assembled from the same pinned Node/Debian inputs, with a reviewed library closure and accurate Debian inventory. It is not a privately patched zlib/glibc distribution, and no scanner exception or required gate was changed.

## zlib investigation

The narrow CVE description is insufficient to mark Debian zlib 1:1.2.13.dfsg-1 safe. An isolated ASan build of its gzwrite source reproduced an invalid write after a direct write fails and the caller explicitly clears the error before retrying. The ordinary error-state control refuses the retry safely. Resetting the retained input pointer/count on direct-write failure, following the published upstream fix, made both controls pass. This source experiment used macOS ARM64 with an identical host-only classic-Mac header compatibility adjustment in both builds; it is not a claim that the deployed amd64 binary or API was exploited.

The Debian source archive SHA-256 was `71feb7947e3c00ef125f83b79a4e529bde31171e5babe48b391f06758d1ab0a1`; gzwrite.c SHA-256 was `c7454689751c8f41ec63a1381a0053fb149095abe1c3b89c8a996b2d7ac8adce`. The source archive matches the previously verified Debian source-control checksum. This verifies downloaded bytes, not a new independent signature check. The experiment and complete outputs remain private; no reproducer is added to the public repository.

References: [Debian record](https://security-tracker.debian.org/tracker/CVE-2026-85091), [older-version report](https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=1146895#36), [upstream fix](https://github.com/madler/zlib/commit/df84af25dc1942490e1d1c899a07619152a46148).

The candidate removes system libz and all the OS utilities that depended on it. Node's statically linked compression library remains: its version number is not changed, and this PR does not claim to patch it. Node's JavaScript compression interface does not expose the gzip-file writer API involved in this finding. The build rejects additional native code/addons and unreviewed libraries; adding those requires a fresh assessment. The real image test preserves Node gzip/gunzip behavior. Monitor upstream Node security releases; code removal here is not a blanket assertion that the Node binary has no vulnerabilities.

## Disposition of the seven reported HIGH findings

These conclusions concern the new local candidate, not the previously imported staging image. No staging image, plan or service was changed. A future authorized registry import must be scanned independently; no new ECR result is claimed.

| Finding | Candidate disposition |
| --- | --- |
| [CVE-2026-78410](https://security-tracker.debian.org/tracker/CVE-2026-78410) | mount/libmount and user-mount tools removed; no user fstab entries. |
| [CVE-2026-78408](https://github.com/util-linux/util-linux/security/advisories/GHSA-55fx-f4gg-cfhj) | nsenter removed. The previous 2.38 build also predates join-cgroup. |
| [CVE-2026-76642](https://github.com/util-linux/util-linux/security/advisories/GHSA-m25x-3hj9-m26f) | mount/libmount removed. Previous-version hook-range conflict is no longer relied on as a runtime control. |
| [CVE-2026-53613](https://security-tracker.debian.org/tracker/CVE-2026-53613) | SUID mount and its library removed; no setuid/setgid executables or user fstab entries. |
| [CVE-2026-53615](https://security-tracker.debian.org/tracker/CVE-2026-53615) | libblkid and partition-probing utilities removed. |
| [CVE-2026-85091](https://security-tracker.debian.org/tracker/CVE-2026-85091) | Affected system library removed; bundled Node compression retained with the API/reachability limits above. |
| [CVE-2026-84243](https://security-tracker.debian.org/tracker/CVE-2026-84243) | **Open:** glibc remains. No fixed Bookworm package was listed during review. No non-C locales/catalogs are copied; C locale defaults and read-only deployment reduce the identified gettext prerequisites. This is mitigation, not a package fix or accepted waiver. |

The final inventory is derived from `dpkg-query --status` for libc6, libgcc-s1 and libstdc++6, which own the copied libraries. Debian identity remains visible to scanners. The root is intentionally not a complete apt-managed system; it has source-package inventory for the selected runtime files. Do not erase metadata or suppress findings to make a scan green. Existing CI blocks fixed HIGH/CRITICAL findings and ignores unfixed ones; passing that gate is not a zero-finding claim.

## Compatibility and verification

The runtime dependency closure is deliberately linux/amd64, matching the existing build and Fargate platform. Host-side guard tests cover missing/extra libraries, the ELF loader, renamed native code, nested addons and external symlinks. Actual image checks cover absence of the excluded code, non-root/read-only operation, locale policy, package inventory, compression and NSS lookup. The existing production-mode rehearsal covers real TLS PostgreSQL, provisioning, migrations, login privileges, the worker, two APIs and containment rollback. API, worker, issuer and migration/provision commands retain their Node entrypoint/working-directory contract.

No Terraform change, deployment authorization, risk waiver, clinical logic change or database migration is part of this PR. New runtime dependencies, locales or a different architecture require review. Future release acceptance must use a newly built/scanned artifact and its own plan; it must not reuse the earlier staging plan for another image.
