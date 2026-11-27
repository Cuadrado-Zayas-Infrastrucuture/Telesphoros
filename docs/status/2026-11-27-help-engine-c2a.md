# Spec 053 slice C2a: Help's engine moves to packages/help-content

Date: 2026-11-27

The first of C2's three pull requests ([plan](../../specs/053-help-chat/plan-slice-c2.md)):
- **What moved.** Help's patient-question rule (`isPatientQuestion`), its search (`searchHelp` and helpers) and its answer (`answerFor`)
  moved from `apps/frontend/src/lib/` into `packages/help-content/src/engine/`, with their tests. The help lane on the server (C2b) will
  use the same code.
- **The frontend.** Its two files now re-export the engine, so no import changes. A frontend test fails if a copy of the engine appears
  there again. The test that Help's roles match the product's roles stays in the frontend, because it needs `shared-types`.
- **Roles** are plain strings in the engine.
- **The breakage catalogue.** Entries H2-1, H2-3, H2-4 and C1-1 point at the moved files.

Nothing on screen changes, and no model, route or setting is added.
