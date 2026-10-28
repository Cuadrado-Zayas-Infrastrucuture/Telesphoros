# Tasks: Progressive blur at scroll edges (PBE)

**Input**: [spec.md](spec.md), [plan.md](plan.md)

**Tests**: Required (SC-001 to SC-003). Each check is seen failing before the change that makes it pass.

## Phase 1: the rule (this branch)

- [ ] T001 [US1] Gate tests: reject a CSS `backdrop-filter`, a CSS `filter: blur()`, Tailwind `backdrop-blur-md` and `blur-sm`, and an inline `backdropFilter`, outside the allow-list. Accept the same blur inside it. Run them and see them fail.
- [ ] T002 [US1] Add the blur rule to `apps/frontend/scripts/check-branding.mjs`; T001 passes.
- [ ] T003 [US3] Gate test: reject a changed `--size-blur-edge`; pin it in `branding-policy.json`, add the token.
- [ ] T004 [US2] Component tests: `aria-hidden`, layer clamp, strength clamp, no layers above 3.5px. Run and see them fail.
- [ ] T005 [US2] Vendor `components/motion-primitives/ProgressiveBlur.tsx` with README and LICENSE; add `styles/progressive-blur.css`; T004 passes.
- [ ] T006 [US2] Remove the clamp and `aria-hidden` in turn; confirm T004 goes red; restore.
- [ ] T007 [US3] Update `branding.md`, `apps/frontend/AGENTS.md`, the `tokens.css` comment.
- [ ] T008 Full local loop; gitleaks on `HEAD`.

## Phase 2 and 3 (later branches)

- Slice 2 `feat/reports-funnel`: Skeleton and FunnelChart on Reports.
- Slice 3 `feat/assistant-prompt-kit`: the conversation, the first user of `ProgressiveBlur`, with browser evidence.
