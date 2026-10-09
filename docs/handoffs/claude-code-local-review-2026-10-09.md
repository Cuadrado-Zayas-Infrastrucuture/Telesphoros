# Claude Code handoff — local synthetic review workflow

Repository: Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered.
Branch: feat/local-synthetic-review-workflow. Base main: 435e532929cf5d1cf617fcfcb3eb5d5c63007efb.
This delivery is a draft PR. Do not merge without Jan's explicit instruction. Read CONTRIBUTING.md, docs/STATUS.md and applicable AGENTS.md first; propose a bounded plan and wait for approval before new work. One intention per PR, each from fresh main. Never stack or use Update branch. Verify merges by file content.

## Delivered

Development-only pages: LocalUploadReportPage, LocalReviewPage and LocalOperationsPage. LocalReportApi supplies real synthetic upload/completion with retry identity and local-emulator checks. Production uploader and backend defaults are untouched. Operations expose existing server correction/dispute/history/impact/ledger behavior without duplicating authority rules.

`scripts/local-review/README.md` is the portable runbook. The unified launcher owns one emulator and bucket; database setup creates a dedicated synthetic PostgreSQL16 cluster. The optional local Poppler adapter uses pinned26.03.0, hashes the executable, refuses build drift and accepts only committed D01 PDF bytes. It is not a general production runner.

## Resume

1. Review this PR and its CI before adding work. Fetch main and inspect all PRs; do not assume this branch merged.
2. Follow the runbook with Node22.22.0, pnpm10.28.0 and PostgreSQL16. Install Moto from the existing pinned CI requirements; use the pinned reader environment. No paid cloud resources are needed.
3. Use committed synthetic fixtures only. Existing user capture approvals must not be invented or replayed. Capture review compares PDF with stored text and uses a different actor from upload.
4. Verify defaults off in production and development routes absent from production chunks. Run frontend tests, Poppler tests, defect injections, and all three backend tiers with PG/S3 endpoints supplied; skips are not passes.
5. Next proposed slice: durable local emulator storage and reproducible clean-machine setup. These are known gaps, not permission to deploy. Keep the original template grammar/clinical/lookup rules unchanged unless separately approved.

## Boundaries and remaining work

Moto objects disappear at launcher shutdown, while DB records persist. Historic links therefore become unavailable after restart; reupload synthetic fixtures. No reset utility is shipped. No arbitrary PDF support, OCR policy expansion, production Poppler integration, model selector, training run, clinical approval, AWS resource creation or DNS change is included.

The independent/unseen real-capture experiment remains separate; D01 is visible engineering evidence. Human roles and governance decisions already supplied by Jan are not replaced by this tool. Clinical/training flags remain false. Persisted holds and abstentions remain distinct.

Codex worked from a byte-verified GitHub main export because terminal Git credentials lacked access. GitHub connector publication uses the actual remote main commit as parent. The local export is not a remote clone; a local empty Git repository was initialized only for Git-attribute-dependent tests.
