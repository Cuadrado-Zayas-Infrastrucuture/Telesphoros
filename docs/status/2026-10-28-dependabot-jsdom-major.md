# Dependabot no longer proposes jsdom majors (config)

Date: 2026-10-28

Follows [engine-strict](2026-10-28-engine-strict.md), which held jsdom on 29 because jsdom 30 needs Node >=22.22.2 (Unicode 17.0) and the
pinned 22.22.0 has the Unicode 16.0 the lab-report matcher requires. Under `engine-strict`, a Dependabot PR to jsdom 30 would fail its install.

**The fix.** `.github/dependabot.yml` ignores jsdom major updates in the npm block, beside `@nestjs/*`; jsdom 29 minor and patch updates still
arrive. `missingIgnores` in `.github/ci/guard.test.mjs` now requires that entry, majors only, with two controls: the entry renamed, and the
entry without its `update-types` line (which would freeze every jsdom update).

**Not changed.** The `jsdom: ^29.1.1` workspace override, the Node pin, and the other ecosystems.

**Checked locally (Node 22.22.0).** `pnpm test:ci-config` 207/207. Removing the jsdom entry from the real `dependabot.yml` turned the guard red
(`npm: jsdom`); restoring it turned it green. The file parses as YAML with both ignore entries.
