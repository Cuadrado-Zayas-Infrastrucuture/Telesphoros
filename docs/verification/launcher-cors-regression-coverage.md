# Launcher CORS regression coverage — 2026-10-14

## Current-main reconciliation — 2026-10-15 (local)

`fix/launcher-cors-current-main` is independently based on main `7bf283a2eb4c4680bde52541e0214cbc79e19fa0`. It carries only PR #105's outstanding 12-file launcher/CI intention from `25ddb185a566c260da2d238c0cf3a5105d946ee0`. The old status paragraph did not apply to main's newer upload-navigation section; it was replaced with the current local-reconciliation status. This verification note preserves dated capture history below. All runtime, fixture, guard and package-script bytes match #105's reviewed head.

Main already includes #116's worker-cap test repair; both that test file and its verification record remain byte-identical to main. The existing #105 branch is unchanged and its old failed CI run is not evidence for this replacement. #111 and F06/F07 branches are unchanged. Nothing was pushed, merged or deployed for this reconciliation.

Local verification: Node 22.22.0 / pnpm 10.28.0 / Moto 5.2.4 / workspace Chromium; **5 native controls passed, no skips; 63 workspace/ownership/CI guards passed, no skips**. Workspace lint, type-check and builds passed. Native checks retain actual child-environment capture, the owned worker handoff, policy readback, declared-method success, excluded-origin simple-GET refusal and same-document success after allowing that origin. Owned methods remain GET/HEAD and older review methods remain PUT. The fixture stubs unrelated DB/readiness/receipt work; it does not establish a full launcher lifecycle or AWS/IAM acceptance.

Three independent scratch-source trials physically delete either launcher setting or remove it at the worker handoff. Each runs only the two baseline browser cases: exactly the affected baseline fails by reading the pinned synthetic bytes from the excluded origin; the unaffected baseline passes. The three embedded expected-defect cases are excluded, not counted as passes. The first scratch harness lacked required runtime modules and was corrected; an initial worker variant triggered the environment-reference assertion before browser contact, so an in-place deletion control additionally exercised the browser oracle. Neither setup issue changed candidate source or counts above.

Remote CI, PostgreSQL/S3 application tiers, full-app browser regression and image rehearsal were not run for this unpushed head. The merged #116 CI results concern its tested merge, not this branch. Future delivery requires a separately approved replacement draft PR and all six required checks on its exact head; retain #105 until the replacement is verified and approved for disposition. No deployment is authorized. F07 integration and hosted acceptance remain separate.

## Historical local capture (2026-10-14)

This fresh main-based local branch carries draft #103's reviewed two child-environment settings and corrected method inventory, then closes review finding RPR-01 with repository tests and CI wiring. Main baseline: `4400efa`. Existing PR branches and F06/F07 are unchanged. No push, replacement PR, merge or deployment.

## Root cause and controls

The original repair passed manual native probes, but removing its settings still passed the existing 58 workspace/ownership/CI guards. The new `pnpm test:launcher-cors` command uses existing workspace AWS SDK and Playwright dependencies plus the pinned Moto package in `.github/ci/requirements.txt`; it reads no frozen F07 source or external worktree.

The fixture evaluates the actual owned runtime setup/fork and worker spawn path, and the older review launcher's actual spawn path, in a VM. Database work, readiness, receipt publication and unrelated API/IDP/web startup are stubbed; this is not a full lifecycle/PG test. Captured environment/arguments feed a new real Moto process and native Chromium with two real loopback document origins. Only the owned child's bind message authorizes endpoint contact. Each test owns and cleans its browser, HTTP listeners, Moto handle and inode-checked mkdtemp tree; nothing existing is reused.

Both launchers start with a false parent setting and a synthetic parent credential sentinel. The explicit child setting must be true, and parent credentials must not be inherited. The owned worker must preserve the exact environment and loopback arguments; removing the setting at that handoff is tested separately.

Each launcher's actual policy is captured and read back: owned **GET/HEAD**, older review **PUT**. The allowed origin successfully performs its declared GET or PUT; PUT bytes are read back through the SDK. A separate version-pinned **simple GET** is the fallback-sensitive origin probe. Excluded origin access must fail; changing only the policy's allowed origin must let the **same live document and URL** retrieve the exact pinned synthetic bytes; the original policy is restored/read back. GET preflight behavior is also checked against the declared methods.

Moto 5.2.3 already rejects the excluded-origin PUT preflight even when the global setting is missing. Its simple GET path exposes the global fallback; merely testing PUT would miss the reported defect. Moto also treats any nonempty value, including `false`, as enabling its disable flag. Fault injection therefore deletes the setting; it does not substitute the string `false`. This is emulator-origin evidence, not AWS method/IAM acceptance.

## CI entry point

The existing required `browser` job runs `pnpm test:launcher-cors` after installing Chromium/system libraries and pinned Moto, before its existing frontend E2E command. No job/check name, required rule, action pin, permissions or cloud credential changes.

CI guards reuse the existing job/command parser. They reject a missing or duplicate native command, conditional job/step, swallowed producer failure, continue-on-error, premature execution and an altered package command. A failing stub producer confirms the actual shell command preserves its nonzero status. The new tests fail if prerequisites are missing; they never skip for missing Moto or Chromium.

## Local verification and re-review

- Native suite: **5 passed; zero failures, cancellations or skips**. Two complete launcher cases plus three expected-defect cases: either launcher setting deleted, and the owned worker handoff dropping it.
- Existing workspace/ownership and extended CI configuration guards: **61 passed; zero failed/skipped**.
- Independent re-review uses two separate scratch file copies, physically deleting one launcher setting at a time and running only the two baseline browser cases. Each copy produces exactly **one expected failing baseline and one unaffected passing baseline**. The three embedded fault cases are filtered out in these trials; they are not counted as passes.
- Syntax, whitespace, changed-document links and redacted staged-secret checks are recorded with the final local receipt.
- Initial fixture/runtime failures were repaired, not counted as passes: missing VM timer/DB adapter seams; absent pinned browser; a PUT-only probe that did not expose simple-GET fallback; a worker mutation substituting a nonempty false value. An external result-parser error was corrected without changing native outcomes.

RPR-01 is closed locally after these checks. New-head remote CI has not run because no push is authorized. Full app builds, PG/S3 API profiles and image rehearsal were not repeated for this test/CI slice; they remain required on future delivery. The original #103 CI results concern only its original head.

## Deferred

F06/F07 remain local and frozen. Older-review GET integration still waits for F07 on main. These tests intentionally preserve today's GET/HEAD versus PUT inventory; an approved future policy change must update that oracle and retain the refusal/success controls. No clinical, tenant, permission, schema, retention or production behavior changed.

## Moto pin drift repair — 2026-10-15

The preceding sections record the original local capture. PR #105's later head `54809cc` failed its browser job after merged Dependabot PR #107 changed `.github/ci/requirements.txt` to Moto 5.2.4. Three owned-launcher cases aborted with `Moto 5.2.3 required.` before browser assertions; the two review-launcher cases passed.

The requirements entry is now the single version source for owned-launcher validation, the initial manifest, the native fixture prerequisite and rehearsal version reporting. Validation still queries the Python next to the selected Moto executable and requires an exact match. Missing, malformed, unpinned or duplicate Moto entries refuse setup. Historical observations above about Moto 5.2.3 remain historical.

Two controls in the existing required operations suite evaluate the actual configuration and initial manifest path with synthetic prerequisites. Changing only the requirements bytes and installed version to a future `9.8.7` must succeed and record that version; leaving the old installation or supplying another mismatch must refuse before owned resources are created. Missing/comment-only, malformed, unpinned and duplicate entries also refuse. The tests failed against the pre-repair runtime. Independent scratch source copies reintroduced hardcoded validation, a hardcoded manifest and disabled version refusal separately; the regression rejected all three.

Local repair verification: Node 22.22.0, Moto 5.2.4; **5/5 native CORS controls** and **63/63 workspace/ownership/CI guards**, with no skips. Syntax, whitespace and redacted diff-secret checks passed. The first native attempt stopped on a missing Chromium revision; installing the checkout's required browser and rerunning produced the passing result. Full owned-stack lifecycle/PostgreSQL acceptance was not rerun locally. Remote CI on the repair commit is tracked in PR #105; no merge or deployment is authorized.
