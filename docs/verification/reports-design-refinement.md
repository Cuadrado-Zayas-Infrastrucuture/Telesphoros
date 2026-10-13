# Reports dashboard: button and layout iterations

October 13, 2026. The founder requested changing the buttons and further iterating the design against the seven reviewed references. Work remains on `feat/reports-loading-interactions`, based on main `0e7e8d8`, with the previously authorized loading improvements included.

## Three visual passes

| Pass | Observation and change | Evaluation |
| --- | --- | --- |
| 1: button hierarchy and surfaces | Underlined utility actions competed with primary actions. Added a raised teal primary button, outlined secondary actions, quiet ghost actions, consistent line icons, opaque report/detail panels and a grouped metadata area. | Inspected actual desktop/mobile list, loading and detail screenshots; both focused browser cases passed. The mobile toolbar was still too tall and filenames were truncated too early. |
| 2: density and mobile reading | Moved patient refresh beside the selector, kept routine patient-option status available to assistive technology without occupying a visible row, wrapped filenames and shortened repeated patient labels in rows. Added 44px minimum button width/height and checked disabled hover behavior. | All 26 owned browser cases passed. Visual inspection caught an awkward split of “complete” in the narrow mobile upload column despite passing automated checks. |
| 3: proportions and context | Restored sufficient mobile status-column width, used natural filename wrapping, and explicitly labeled patient pagination separately from report pagination without a duplicate live status. | All 26 owned browser cases passed again; inspected mobile words/filenames and desktop loading/detail views. Existing 200% text, focus return, paging, role and transport checks remain intact. |

The primary button has a subtle brand-colored shadow and highlight, with an inset pressed state. Secondary buttons retain a clear control boundary. Ghost actions stay quiet. Disabled controls retain focus where required but do not gain hover treatment or submit repeated requests. Reduced motion disables transitions and the skeleton pulse. No pill statuses or emoji icons were introduced.

Core dark teal, seafoam, stone, off-white and Poppins typography remain. A white neutral panel token separates operational surfaces from the off-white canvas; elevation and button sizes are declared in the shared token file. Button sizes are 44/48/56px. No UI package was added.

## Reference application

- [shadcn Skeleton](https://ui.shadcn.com/docs/components/base/skeleton): report-shaped, noninteractive placeholders inside a stable loading layout.
- [Uiverse switches](https://uiverse.io/switches): inspiration for distinguishable control states and restrained tactile depth; existing actions remain buttons rather than switches.
- [Kage](https://kage.design/design/landing-page) and [Prompt Kit](https://www.prompt-kit.com/ai-sdk): clear hierarchy, surface grouping and compact utility controls, adapted to the actual report workflow.
- [Progressive Blur](https://motion-primitives.com/docs/progressive-blur), [Liquid Glass](https://glass.samasante.com/?view=examples) and [IntelliUI Calendar](https://ui.intellihelper.in/components/event-calendar): reviewed for depth and interaction presentation; no blur over report data, refractive rendering, calendar workflow or AI feature was added.
- [CMS principles](https://design.cms.gov/guidelines/design-principles/): consistent action hierarchy, readable results, clear recovery and role-appropriate tasks guide the implementation.

These are original adaptations using existing primitives and tokens, not copied third-party gallery code.

## Verification

| Check | Final result |
| --- | --- |
| Frontend units | 229 passed across 19 files. |
| Frontend typecheck, lint, production build | Passed. |
| Chunk/foundation guards | Passed; entry 113.2 KiB gzip against 150 KiB budget, eight lazy pages, 46 component modules. DEV pages remain outside production chunks. Entry size alone is not a total-download performance claim. |
| Owned browser suite | 26 passed at 375px and 1280px on the final third pass. Includes real HTTP intake/download, restricted PostgreSQL role, pinned-version Moto files, role/tenant refusal, disabled clinical capture, loading/error recovery, keyboard focus, reduced motion, 44px targets and disabled hover. |
| Standard / DEV browser regression | 56 standard and 18 DEV cases passed after the final changes, covering screens that share Button styling, keyboard/touch access, upload recovery, local validation and route/role boundaries. Total final browser acceptance: 100 cases across the three suites. |
| Visual review | Inspected rendered loading, populated list, selected metadata and verified-file download views. Automated axe checks in exercised states passed; this is not full accessibility certification. |

The owned synthetic run `2f24b49f-7e98-435b-8f74-51c9e06d05e4` used the exact CI Node 22.22.0 / Unicode 16 runtime, PostgreSQL 16 and Moto 5.2.3. Its runner confirmed teardown after the written ownership/blast-radius check; the retained receipt is `removed` and the run directory is absent. The standard/DEV suites used their existing isolated loopback fixtures. No shared database or AWS environment was used. Existing non-failing Vite chunk-size and DEV hydration warnings remain; the repository's actual chunk guard passed.

No backend, schema, authorization, download verification, route registration, clinical gate or production configuration changed. Shared Button styling reaches existing pages; their business behavior remains unchanged. Full backend regression and remote CI are not claimed. Nothing is committed, pushed or deployed by this iteration.

## Review images

- [Before: initial loading screen](../design/previews/reports-loading-desktop.png)
- [Final desktop with selected report](../design/previews/reports-refined-desktop.png)
- [Final mobile list](../design/previews/reports-refined-mobile.png)
- [Final loading state](../design/previews/reports-refined-loading.png)
- [Final verified download action](../design/previews/reports-refined-download.png)

All screenshots contain generated synthetic fixtures. The workstation output directory `outputs/dashboard-design-iterations/` retains pass-1, pass-2 and pass-3 screenshots for comparison; those intermediate files are not part of the repository diff.
