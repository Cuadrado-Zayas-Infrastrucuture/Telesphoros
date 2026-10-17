# sprintf-js advisory remediation — local candidate

`fix/sprintf-js-toolchain` starts from main `727029d`. This record describes a local, unpublished candidate; it does not close the default-branch alert or establish hosted CI acceptance.

## Reproduced cause and exposure

[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) affects sprintf-js through 1.1.3, with no published patched release at investigation time. The installed 1.0.3 reproduces asynchronous process exits on `%.101f`, `%.101e`, `%.101g` and `%.0g` under pinned Node 22.22.0; valid precision controls succeed.

The native workspace inspection reported 55 paths, each originating in the backend's **development** Jest dependency, through `@istanbuljs/load-nyc-config@1.1.0 -> js-yaml@3.15.2 -> argparse@1.0.10 -> sprintf-js@1.0.3`. Production-only audit already passed, while the full baseline audit exited 1. No application import of this formatter was found. No alert was dismissed or severity filtered.

## Narrow fix and compatibility boundary

The workspace override applies **only** to `@istanbuljs/load-nyc-config@1.1.0>js-yaml`, requiring `^4.3.2`. [The loader's actual source](https://github.com/istanbuljs/load-nyc-config/blob/2033a007672d90669c48c79e6a2d63a3cd0851a7/index.js) calls `yaml.load()`, which [the maintained v4 API](https://github.com/nodeca/js-yaml/blob/4.3.2/README.md) supports. The frozen lock resolves js-yaml 4.3.2 and argparse 2.0.1, eliminating sprintf-js and the now-unused esprima package. The replacement parser's public help renderer also preserves the four precision payloads as text without crashing.

All **1002 unrelated package entries**, all workspace dependency declarations, and the existing esbuild security override remain unchanged. Jest and instrumentation versions, build-script allowlist, application source, test selection rules, coverage settings, timeouts, durability, CI jobs and protections are unchanged.

This crosses a YAML major version deliberately at one caller. Plain NYC defaults, aliases, inheritance, key normalization and array normalization are verified through the real loader; malformed/duplicate YAML and missing/circular configuration still refuse. YAML v4 no longer accepts JavaScript-specific tags by default; this repository has no existing nycrc requiring such tags. Future custom configurations need their own compatibility review.

## Local verification

The new dependency-closure regression fails on baseline (1 failed, 4 positive/refusal controls passed) and passes after installation (5/5). The **unfiltered full audit exits 0 with zero advisories** and recursive dependency inspection finds no sprintf-js paths. Frozen install, types, lint, builds, all 137 CI guards, 403 frontend checks and 285 library checks pass under Node 22.22.0 / pnpm 10.28.0.

| Profile | Passed | Intentional skips | Failed | Total |
| --- | ---: | ---: | ---: | ---: |
| memory | 2226 | 253 | 0 | 2479 |
| postgres | 2458 | 21 | 0 | 2479 |
| postgres-s3 | 2478 | 1 | 0 | 2479 |
| worker | 123 | 0 | 0 | 123 |

Every backend profile retains the accepted main test count plus exactly five new cases and one new suite. Fixtures use fresh loopback PostgreSQL 16/Moto with fsync, synchronous_commit and full_page_writes on. All nine recovery reports are fresh within their producing profile and retain passing controls. Both existing F2/F3 all-profile recovery validators pass on the Mac. The separate Linux/x64 CI envelope remains unrun; Mac platform metadata is retained unchanged. The additional Babel coverage run passes 17 tests and produces nonzero measured coverage for the selected source file.

Local runs tested the candidate bytes at base HEAD; retained input hashes are checked against the final local commit. The local Jest/Vitest reporters provide final counters without per-suite PASS records; these are local results, **not CI joining receipts**. Complete native stdout/stderr and producer exits, the controlled baseline failure, source hashes and recovery reports are retained privately and summarized in Obsidian.

## Remaining acceptance

All six required hosted checks remain mandatory: verify, database-and-storage, browser, terraform, secret-scan and image. No PR, push, merge, manual deployment or production test is part of this local investigation. Exact-head hosted CI and default-branch Dependabot acceptance require the subsequent authorized review/merge flow. Existing notes, feature/fix branches and legacy/recovery archives remain preserved.
