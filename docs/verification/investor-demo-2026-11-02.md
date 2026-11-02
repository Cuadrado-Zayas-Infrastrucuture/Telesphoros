# Investor prototype rehearsal

Date: 2026-11-02

## Source and scope

Application source: `e07619ec09ffac1973678141e2849479fb891217` (merged #256). Local branch: `docs/investor-demo-preparation`. Application code is unchanged. The only test change scopes the existing Add patient click to the main landmark because desktop navigation now has another button with the same name. AI-assisted preparation; manual visual inspection described below.

The founder authorized proceeding with investor-prototype preparation. This is local synthetic rehearsal evidence, not hosted or clinical acceptance. Presenter script and acceptance checklist: [investor-demo.md](../investor-demo.md).

## Environment

Pinned Node 22.22.0 and pnpm 10.28.0; PostgreSQL 16.13 (Zonky packaged binaries); Moto 5.2.4 in an isolated Python 3.12 virtual environment; system Chromium through the existing `CHROMIUM_PATH` override. Tools were obtained under `/tmp/telesphoros-investor-tools`; no repository dependency or lockfile changed. The initial default environment had Node 24 and pnpm 11; its focused UI test pass was repeated under the pinned versions.

Owned storage run: `4aa7dff3-1d79-47fe-84db-39c98d0f5111`. Real local PostgreSQL migrations, restricted application role, Moto S3, fake identity provider, API and built frontend. Clinical processing stayed disabled. No AWS deployment, model call or real patient data.

## Results

| Check | Result |
| --- | --- |
| `pnpm demo:product:build` | Passed |
| Focused `SyntheticReportDemo.test.tsx`, pinned Node | 11 passed |
| Initial six product-demo browser cases | Mobile: 3 passed. Desktop: 3 failed at the ambiguous Add patient selector before submission |
| Same six cases after landmark-scoping the selector | 6 passed: D01, D08 and unmapped/misnamed D02, at 375px and 1280px |
| Separate desktop recording run using the same test cases | 2 passed: D01 and D08; temporary recording-only config, no service/config change |
| `pnpm typecheck` | Passed |
| `pnpm lint` | Passed, including formatting |
| `pnpm build` | Passed |
| `pnpm test:ci-config` | 217 passed after rerunning outside the restricted process sandbox |
| `pnpm test:infra` | 285 passed outside the restricted process sandbox |
| `pnpm check:workflows` | Passed |
| Status-fragment guard after adding this slice's record | 12 passed |
| `git diff --check` | Passed |
| `pnpm test` | Failed: backend 2 failed, 2,075 passed, 451 skipped; 154 suites passed, 2 failed, 25 skipped. Not a green repository run |

The two backend failures are in `subprocess-report-reader.wrapper.spec.ts` and `subprocess-report-reader.cancel.spec.ts`: their process-tree cleanup assertions still observed a child as alive after deadline/cancellation. These files were not changed; cause has not been established or repaired by this slice. Do not claim they are harmless or merely flaky. The demo's reader stays disabled and all its real browser controls passed.

Default database/S3 backend and worker tiers were **not run**, and five reader-engine-dependent specs were explicitly skipped because the optional engine is absent. The actual local demo does exercise PostgreSQL and Moto, but is not a substitute for those full tiers. The overall workspace test command failed, so package-level successes are not a claim that every workspace test finished.

Early restricted-sandbox runs of the workspace and CI-config tests returned child-process failures. The superseded restricted infrastructure run was stopped after the unrestricted run passed. The subsequent runs above are the reported outcomes. No assertion, application guard, timeout or required check was weakened.

## Artifacts and visual review

Retained workspace artifacts, outside git:

- `/workspace/investor-demo-assets/investor-prototype-preview.mp4`: 31.29-second silent preview combining actual D01/D08 browser recordings with six-second holds on each result screenshot. Persistent caption: synthetic prototype, fixed sample results, no clinical processing. This is an automated preview, not a narrated human rehearsal.
- `/workspace/investor-demo-assets/sample-result-desktop.png`
- `/workspace/investor-demo-assets/sample-held-desktop.png`
- `/workspace/investor-demo-assets/sample-result-mobile.png`
- `/workspace/investor-demo-assets/sample-held-mobile.png`
- `/workspace/investor-demo-assets/browser-recordings/`: original desktop WebM recordings.

All four screenshots were opened and visually inspected. The result and hold disclosures are visible; desktop retains the Reports context; mobile keeps the compact drawer layout. Browser controls also checked accessibility, keyboard access, 44px button heights and no horizontal overflow. Mobile D08's lower source disclosure requires scrolling; it is not all visible in that one viewport screenshot.

Raw command logs live under `/tmp/telesphoros-investor-tools/`. They are local execution records, not CI evidence or durable repository artifacts.

The exact run's blast-radius record was read before cleanup. Its UUID-scoped teardown returned `Owned teardown verified`; all five demo ports were free afterward. Artifacts remain outside the deleted disposable run.

## Remaining acceptance

Two timed human rehearsals and a narrated recording on the actual presentation machine remain. Medication capture was not rehearsed and is excluded from the core script. Actual report extraction, review persistence, computed clinical results, live explanations, clinical validation and real-data operation remain separate milestones. Staging was not read or modified in this session. Nothing was pushed, merged or deployed.

## Follow-up: narrated draft and full-sequence rehearsals

The founder authorized continuing presentation preparation. New owned local run: `82df28bf-0ef9-481f-a99f-072e5d6d6b01`, on the same application source and tools. No application code or dependency changed.

Two complete automated sequences passed: an unpaced functional run (4.001 seconds, excluding sign-in) and a narration-paced recording (180.965 seconds, excluding sign-in). Each created two fictional patients through the UI, uploaded D01 and D08, opened the fixed result and hold, and observed zero capture/evaluation/decision/patient-link processing requests. Every action completed within its narration segment. The maximum action time in the paced run was 2.359 seconds, for the second patient/upload/hold transition. These numbers measure automation, not human presentation speed.

Early recording-script attempts failed because of a mismatched report selector, a reused patient label, and a full-page navigation that intentionally cleared in-memory sign-in. The temporary script was corrected to use the existing report-row selector, unique fictional labels and **Back to reports → Upload synthetic report**. No application behavior, role, test assertion or clinical boundary changed. Preference consent does not persist authentication tokens; the successful flow uses in-app navigation.

Artifacts under `/workspace/investor-demo-assets/narrated/`:

- `investor-walkthrough-narrated.mp4`: approximately three minutes; English eSpeak NG synthetic-voice draft, normalized audio, burned-in sentence captions and a persistent synthetic/fixed-result disclosure. Original application content is preserved above a separate caption band.
- `narration.txt`, `presenter-cues.txt`, `captions.srt`: transcript, timed cues and portable subtitle file.
- `rehearsal-results.json`: scene timings and zero-processing-request receipts for both completed runs.
- `scene-1.png` through `scene-6.png` and `raw/`: presentation states and original browser footage.
- `README.txt` and temporary generation scripts: artifact scope and local reproduction references; these are not product features or production tests.

Speech tools were extracted under `/tmp/telesphoros-investor-tools/tts/` from Debian packages, without system installation. Narration used local synthesis, not an external voice API. This is a reference voiceover for review, not a human performance. Human delivery rehearsal, sound/playback on the actual meeting machine and the unresolved full-suite backend failures above remain open. Clinical computation and validation remain outside this presentation slice.

Export checks: 180.88 seconds, H.264 video at 1280×920 and AAC audio; complete decode succeeded. Result and hold frames were inspected, including caption placement. The recorded hold explanation was initially below the viewport, so from 2:02 onward the edited draft uses the earlier passing rehearsal's held-detail screenshot, visibly labeled **Held example detail — earlier local rehearsal**. Narration and captions continue over that cutaway; this is an edited presentation, not an unbroken recording. The saved temporary script now scrolls the held heading into view for future runs; that additional script adjustment was not rerun. No application change was needed.

The follow-up run's exact teardown scope was reviewed, then UUID-scoped teardown returned `Owned teardown verified`. Updated status-fragment checks passed (12 tests), and `git diff --check` passed. This documentation/media-only follow-up did not repeat the earlier full repository checks or resolve their two backend failures.
