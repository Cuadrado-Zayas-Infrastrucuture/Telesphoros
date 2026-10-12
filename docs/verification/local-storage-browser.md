# L2 browser verification — 2026-10-12

Base: `2e817cf` (main after PR #78). Scope: explicitly opted-in local standard browser upload, paginated report access, exact-version attachments. No backend implementation, migration, clinical-review workflow, L3 operational code, AWS action, deployment or PR is included.

## Controls

- Reuse L1 attempt/revision/raw intake/resume/cancel APIs and tenant-bound report/download services.
- Preserve original declaration tokens through reply loss; never fall back to a legacy write target after refusal.
- Keep retry identities in memory. Require server acknowledgement for cancellation; preserve known identity if a response disagrees.
- Bound downloads, verify size/hash, reject unsafe/expired links and redirects, omit credentials/referrers, revoke temporary object URLs.
- Keep product-only PDF schema expansion separate from the experimental upload schema.
- Use local synthetic PostgreSQL16 through the restricted application role (verified non-superuser, no BYPASSRLS), Moto 5.2.3 and fake-IdP browser authentication. Preserve the database/logs; stop only owned services. The test-only version fault adds inert bytes to its owned bucket; Moto disposal loses only those reconstructible fixtures.

## Acceptance matrix

| Check | Evidence |
| --- | --- |
| PDF/VCF/JSON round trip | Real browser → authenticated API → versioned Moto, downloaded bytes/hash equal input, mobile and desktop |
| Reply loss | Registration, declaration and committed-byte replies lost; one report and one byte transfer |
| Cancellation | Interrupted transfer, explicit server acknowledgement, start-over remains locked until acknowledgement |
| Validation | Malformed JSON refused; complete before/after version inventories unchanged; no legacy write fallback |
| Clinical boundary | Successful files remain received; capture requests return 503 |
| Access | Reader has no download controls/API access; foreign report metadata returns 404; reviewer can download but cannot use upload page |
| Download integrity | Newer object version cannot substitute for pinned bytes; unsafe/expired URLs and wrong bytes refused in unit tests |
| UI | Bounded pagination, keyboard download, no horizontal overflow, WCAG A/AA automated checks |
| Compatibility | Existing foundation and development browser suites retained |

Limits: local synthetic acceptance only. In-memory retry state does not survive navigation/reload. Moto is not provider IAM/retention/expiry/custody proof. L3 and deployment remain separately unapproved. No remote CI for this branch is claimed.

## Results

- Frontend unit/component suites: **197 passed** (16 files), including 13 new transport controls.
- L2 browser acceptance: **17 passed** (8 checks each at 375px and 1280px, plus the final exact-version substitution control).
- Existing browser regression: **54 foundation + 18 development passed**.
- Workspace tests passed: backend **1,222 passed / 201 deliberate service-tier skips**, shared types 22, CPIC schema 36, fake IdP 7, SMART pilot 186, notification Lambda 9. Frontend was independently rerun after the final transport changes.
- Workspace build, typecheck and lint passed; frontend route/chunk checks and CI configuration guards passed. The frontend was checked again after its final changes.
- Runtime: Node 22.22.0, PostgreSQL16, Moto 5.2.3. The L2 browser suite used real PostgreSQL RLS and S3 protocol, not the skipped unit-tier service tests.

Resolved verification issues: initial sandbox loopback bind refusal (rerun with permitted local test-server access); generated browser build directory included in lint (narrow output exclusion); tests assuming a newly created report was on page one (bounded page navigation); anonymous Moto overwrite fault injection (explicit dummy-authenticated local SDK); hard navigation discarding memory-only browser authentication (use the existing SPA link). No product authorization or storage invariant was weakened to pass these tests.

Final staged-diff Gitleaks scan: no leaks found. Owned browser services terminated through their existing fixture lifecycle; the exact PostgreSQL cluster started for this check was stopped after verification. Synthetic database/log files were preserved. No teardown/reset of other resources occurred.
