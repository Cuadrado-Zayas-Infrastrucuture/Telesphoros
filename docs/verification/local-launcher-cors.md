# Local launcher CORS controls — 2026-10-14

Founder approved Phase A local repairs, launcher controls first, on an independent branch from main `4400efa`. F06/F07 remain frozen; no push, PR or deployment.

## Change and root cause

Moto 5.2.3's global Flask CORS fallback can admit an origin outside the bucket rule. Both `scripts/local-storage/runtime.cjs` and `scripts/local-review/start.cjs` omitted `MOTO_DISABLE_GLOBAL_CORS` in their explicit child environments. Both now set it to `true`; no inherited parent value can override it. No bucket method, origin, permission, ownership, clinical flag or production configuration was changed.

## Verification

Native Chromium/Moto probes used the owned runner's actual exported environment and the older review launcher's captured real spawn-path environment. Only API/IDP/web startup and SDK initialization were stubbed when capturing the latter; its captured environment was passed to a real Moto child. Parent credential inheritance was refused. Each probe used a fresh RAM-only emulator, two real loopback HTTP servers and synthetic bytes.

Both unchanged launchers failed the excluded-origin assertion: expected refusal, received the exact synthetic object. After the change each passed seven controls: exact bucket readback; approved-origin pinned GET bytes; browser PUT refusal; second-origin GET refusal; success from that same document after allowing its origin; original pinned bytes after overwriting the object; restored/read-back policy. All owned services stopped.

The GET policy came from the frozen F07 contract **only in scratch** to isolate the launcher environment defect. It was not copied into this main-based branch. This proves the child environment permits the intended bucket-origin enforcement; it does not claim the differing main launcher policies (owned GET/HEAD; older review PUT) have been aligned with F07 or that Moto proves actual AWS method enforcement.

`node --test scripts/workspace-build/workspace.test.cjs scripts/local-storage/operations.test.cjs`: **22 passed, zero failed/skipped**. Cleanup touched only freshly generated, ownership-checked test fixtures. Source syntax and whitespace checks passed. No frontend/backend build or PostgreSQL tier was rerun for this two-setting change; no schema, API or app behavior changed.

## Deferred integration

After F07 merges, integrate the older local-review launcher with its common GET-only contract on a separately reviewed main-based update and verify the actual configured policy. F07's browser-test child setting stays on F07. This branch adds only the two missing launcher child settings and their documentation; no competing contract implementation or stacked branch.
