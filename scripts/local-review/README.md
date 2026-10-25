# Local synthetic review tool

This is a development-only workflow, not a deployment or clinical release. Production upload code, backend defaults, schema, evidence rules and flags are unchanged. Routes `/local-upload`, `/local-review` and `/local-operations` exist only in Vite development builds.

The launcher's child environment explicitly sets `MOTO_DISABLE_GLOBAL_CORS=true`, preventing Moto's global fallback from admitting origins outside the bucket policy. This local F07 integration uses the shared GET-only report-download contract, with the exact loopback application origin. Upload bytes still enter through the API. Neither emulator results nor this launcher establish actual AWS acceptance. See [verification](../../docs/verification/local-launcher-cors.md).

## Prerequisites and start

From the repository root, `pnpm test:launcher-cors` verifies both launcher child environments with real synthetic Moto/Chromium origin controls. Install the pinned Moto package from `.github/ci/requirements.txt` (`pip install --require-hashes -r …`; the launcher checks the version against `.github/ci/requirements.in`) and the workspace Playwright Chromium runtime first; `LOCAL_MOTO_PYTHON` may select that Python interpreter. The required browser CI job installs these prerequisites and runs the command. See [coverage and limits](../../docs/verification/launcher-cors-regression-coverage.md). This does not start the full database/API demo. Its independent literal policy oracle requires the shared GET-only policy while retaining the child-setting and worker-handoff defect controls.

Use Node **22.22.0** (Unicode16), pnpm **10.28.0**, PostgreSQL **16**, Python with `.github/ci/requirements.txt` installed for the Moto emulator, and the repository's pinned reader runtime dependencies. The optional real extractor requires `pdftotext` **26.03.0** on PATH. No AWS credentials are required.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm demo:review:setup
pnpm demo:review
# Alternatively, extract the allowlisted D01 PDF with actual Poppler:
pnpm demo:review --poppler
```

`pnpm demo:review:setup` also registers the demo organizations and grants each fake user their membership (derived from the user's groups in `packages/fake-idp`, so the two cannot drift; running it again changes nothing). Without a membership the API answers 403 to everyone. Open `http://127.0.0.1:4173/local-review`. The fake identity provider has synthetic users only: alice uploads; gina is an independent reviewer; hal can administer synthetic operations. Copy the capture ID before switching users. Compare PDF and stored text yourself before submitting acceptance; the tool never supplies a human approval. JSON/VCF upload is at `/local-upload`; history, corrections and disputes are at `/local-operations`.

Defaults: frontend4173, identity4010, API3010, emulator5555, PostgreSQL54359. Override with `LOCAL_REVIEW_WEB_PORT`, `LOCAL_REVIEW_IDP_PORT`, `LOCAL_REVIEW_API_PORT`, `LOCAL_REVIEW_MOTO_PORT`, `LOCAL_REVIEW_PG_PORT`. `LOCAL_PG_BIN` selects PostgreSQL16 executables; `LOCAL_MOTO_PYTHON` selects an interpreter with Moto; `LOCAL_POPPLER_BINARY` selects pdftotext. All services bind loopback. The launcher refuses an occupied emulator port and does not inherit cloud credentials.

The dedicated database uses loopback trust authentication and restricted application/verifier roles. Never store real data in it. Ctrl+C stops the four launcher services. Stop the database separately with `node scripts/local-review/database.cjs stop`. There is no reset/drop command. **Moto storage is ephemeral while database metadata persists:** restarting loses uploaded bytes; use new synthetic uploads rather than relying on old records. Persistence remains follow-up work.

## Verification

```sh
pnpm demo:review:test
node scripts/local-review/check-mutations.cjs
# With the launcher/database running:
node scripts/local-review/verify-upload.cjs
node scripts/local-review/verify-review.cjs
node scripts/local-review/verify-poppler-review.cjs
node scripts/local-review/verify-operations.cjs
```

A failing verify script names the script and line and, for a failed assertion, the two short values it compared (for example `got 403, expected 201`), never a token or a header. `pnpm test:demo-seed` checks the user derivation and the failure report without a database; with `TEST_DATABASE_URL` set to a disposable PostgreSQL superuser URL it also seeds a new database twice. Verification writes new synthetic records. Supply the same PG/Moto port overrides if using custom ports. The Poppler path accepts only the committed D01 source hash; arbitrary, scanned, mixed and OCR-layer PDFs remain refused. Text-byte agreement proves source fidelity, not extraction completeness or correct clinical interpretation. These tests establish local engineering behavior only, not unseen-layout accuracy, model utility or clinical approval.
