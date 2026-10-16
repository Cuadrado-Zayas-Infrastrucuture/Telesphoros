# Product capabilities and delivery state — 2026-10-14

Source baseline: main `4400efae920f4cefa918e9b3c8862b3e5e6af9e9`, after merged PRs [#100](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/100) and [#101](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/101). This is a source/build matrix, not hosted acceptance or clinical approval.

| Build / runtime | Upload | Find / download | Review and interpretation |
| --- | --- | --- | --- |
| Normal frontend build, local-storage flag absent or false | `/reports/upload`, clinician only; VCF/JSON choices; bytes go through validated API intake | `/reports` is not mounted. Authorized exact-version download API exists, but this build does not supply that dashboard journey | Development review/operations/interpretation routes are absent |
| Frontend with `VITE_LOCAL_STORAGE_INTAKE=true` | Same clinician route; PDF/VCF/JSON choices | `/reports` is mounted for clinical read roles; signed version-pinned GET downloads still need the intended bucket CORS in the selected environment | This flag does not enable clinical processing. The server independently gates lab PDFs and pipeline work |
| Vite development server / local review launcher | Product upload plus development-only local upload tool | Development review can retrieve accepted source evidence through existing authorized routes | `/local-interpretation`, `/local-review`, `/local-operations` are development-only protected routes; their operations retain server role and independent-review gates. The review launcher uses only synthetic fixtures |
| Server with `LAB_REPORT_PIPELINE=disabled` (default) | Lab-PDF declaration/send/resume refused; storage-only owned rehearsal has its explicit nonclinical scope | Nonclinical storage permissions and exact-version access remain independently enforced | Pipeline routes refuse processing; a frontend build flag cannot override this |
| Server with pipeline enabled | Synthetic non-production PostgreSQL integration only; recorded-text runner and reviewed fixture boundaries remain | Patient/file identity, permissions and pipeline gates still apply | Production mode and memory-store pipeline enablement are refused; no production PDF extraction or prescribing approval follows |

The browser test build uses the same protected product routes at mobile and desktop widths. A flag that exposes a choice does not establish that the selected API/runtime accepts it. Verify upload → find → download as one journey for the intended build before release.

## Merged versus local versus hosted

| State | Evidence / limit |
| --- | --- |
| Merged on main | M1 authority/security/cache changes; M2.1 patient identity/member APIs; M2.2 durable API intake, retired presigned uploads and browser reload recovery; M2.3 queue/outbox/consumers/worker deployment code. #100 includes M2.1/M2.2/M2.3a; #101 includes M2.3b/c |
| Current CI | All seven reported checks on the final #100 and #101 PR heads succeeded, including the six required jobs. Checks attest to those commits; CI publishes/deploys nothing |
| F06 local only | `fix/f06-upload-recovery-publication`, freshly based on main `75bdc20`, ports reviewed F06 with independent page/session safeguards and all 19 promoted probes (seven races plus 12 recovery-to-download unit cases). Verified caller/tenant-bound one-hour recovery, unchanged roles-only `/me`, separate capability and genuine-404 fallback. Both source branches and the combined reference remain preserved. Old/cached JavaScript needs refresh to obtain the newer safeguards |
| F07 local only | `fix/f07-cors-test` at `47d75cd`: common GET-only reports CORS, exact deployment-origin validation and real-origin browser controls. Main Terraform and the older review launcher declare PUT; the owned storage launcher declares GET/HEAD. F07's common GET-only contract remains local |
| Phase A local only | `fix/local-launcher-cors-parity` at `24f9f52` disables the two launcher global fallbacks; `fix/patient-setup-guidance` at `093ddc6` corrects the clinician handoff. This documentation branch does not include either runtime fix. Older launcher's shared GET integration waits for F07 on main |
| Hosted / real-data acceptance | Not established by this source review. Actual AWS/Cognito/S3/CDN/worker/alarm/recovery evidence, agreements, custody and clinical-release gates remain separate. No deployment was performed |

## Sources of truth

- Frontend routes/roles/choices: [routes](../apps/frontend/src/app/routes.tsx), [roles](../apps/frontend/src/auth/roles.ts), [upload page](../apps/frontend/src/pages/UploadReportPage.tsx), [build flag](../apps/frontend/src/lib/storageMode.ts).
- Server restrictions: [configuration](../apps/backend/src/config/env.ts), [intake](../apps/backend/src/reports/intake/intake.service.ts), [patients](../apps/backend/src/patients/patients.controller.ts), [file downloads](../apps/backend/src/reports/reports.controller.ts).
- Delivery: [current status](STATUS.md), [CI](ops/ci-cd.md), [jobs](ops/jobs.md), [deployment design and gates](ops/deployment.md).

This matrix records existing boundaries; changing the supported product journey, promoting development routes or enabling clinical processing requires its own approved intention.
