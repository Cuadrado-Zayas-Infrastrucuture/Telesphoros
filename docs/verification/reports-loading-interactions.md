# Reports loading and interaction verification

Verified locally on October 13, 2026, on `feat/reports-loading-interactions` from main `0e7e8d8`. See the [approved scope](../design/plans/reports-loading-interactions.md).

This is the initial loading-slice verification snapshot. The later founder-authorized button and layout iterations are recorded in [Reports design refinement](reports-design-refinement.md), which supersedes the presentation and final-test details below.

## Implemented

The report table retains its column headers and bounded height while decorative skeleton rows replace unavailable records. Placeholders are hidden from assistive technology and contain no actions or previous report data. The existing pager supplies one live report-loading message outside the busy region. Motion-safe CSS pulses only when reduced motion is not requested.

A visible clear-filter action works even during a pending report read. Failed reads offer a direct retry that retains the requested page and patient; an empty later page offers a return to page one. Recovery moves focus to the mounted Report records heading before its initiating button disappears. Empty unfiltered lists offer an upload link only for existing writer roles. Keyboard-focused rows gain the existing seafoam background, and report buttons identify the detail panel they control.

## Controls

No authorization, route registration, API/schema, transport verification, branding token, dependency, clinical gate or production configuration changed. Upload remains clinician/admin; verified download remains clinician/reviewer/admin; readers remain metadata-only. Existing abort/late-response handling and mobile detail/back focus remain in place. The owned-storage opt-in and loopback/development restrictions remain unchanged. No public-page work, AI feature or deployment is included.

## Tests and visual evidence

| Check | Result |
| --- | --- |
| Frontend unit suite | 229 passed across 19 files. Added recovery focus, clearing a filter during a pending read, late-response refusal, writer-only empty-state upload, and returning to page one with the patient filter intact. |
| Frontend typecheck / lint | Passed. |
| Production build / chunk and foundation guards | Passed: entry 146.2 KiB gzip against 150 KiB budget, eight lazy page chunks, 46 component modules; DEV pages excluded. No added project dependency. |
| Existing owned-storage browser regression | 24 passed across 375px mobile and 1280px desktop. Real API, restricted PostgreSQL 16 application role, Moto 5.2.3 and fake IdP. Upload/download verification, tenant/role refusals and disabled clinical capture retained their assertions. |
| New dashboard browser cases | Both passed after fixing test navigation. Assert fixed table height, a single loading status, no interactive stale rows, retained keyboard focus, duplicate-refresh prevention, reduced-motion CSS, generic failure text, retry/filter recovery and no horizontal page overflow. |
| Automated accessibility | No axe WCAG 2.0/2.1 A/AA violations in the exercised loading views; existing loaded/detail accessibility cases passed. This is not a complete accessibility audit. |
| Visual inspection | Inspected actual desktop/mobile loading and mobile error screenshots below. Brand palette, type and full-name company endorsement preserved. |
| Diff whitespace | Passed. |

Screenshots contain synthetic fixtures only: [desktop loading](../design/previews/reports-loading-desktop.png), [mobile loading](../design/previews/reports-loading-mobile.png), [mobile failure and retry](../design/previews/reports-error-mobile.png).

## Failures and repairs

Initial local-stack attempts used runtimes outside the repository's exact CI pin. Node 24/20 were refused by the operations runner; Node 22.23.3 passed the major-version check but its Unicode 17 data was correctly refused by the backend's Unicode 16 matcher. Installing Node 22.22.0 in a temporary directory resolved the mismatch without changing repository dependencies or guards. Failed generated stacks were removed by the owned runner.

The first browser run passed all 24 existing cases but the two new cases used a full-page navigation after sign-in. That discarded the intentional in-memory session, so the tests reached Sign in instead of Reports. The tests now use the existing Reports navigation link; both passed on their focused rerun. No authentication behavior or assertion was weakened.

The successful owned run was `174398ea-fb7b-41af-bfe2-25d75c194ee2`, using Node 22.22.0 / Unicode 16, PostgreSQL 16 and Moto 5.2.3. Teardown was limited by the runner's written blast-radius check, independent ownership receipt and PID/start identities to this generated synthetic stack. The runner reported verified teardown; the retained control receipt records `removed`, and the run directory no longer exists. No AWS or shared database was contacted.

Full backend three-tier regression, standard/DEV browser suites and remote CI were not rerun for this frontend-only slice. The service-backed browser checks above do not establish hosted-service, production or clinical acceptance.
