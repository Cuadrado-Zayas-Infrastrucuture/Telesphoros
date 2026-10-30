# Code scanning record matches the live settings

Date: 2026-10-30

**Implemented.** `docs/ops/ci-cd.md` said native code scanning and secret scanning were "not configured" (INF-18, accepted 2026-10-20 as a paid add-on for a private repository). That was out of date. A read-only `gh api` check on 2026-10-30 found:
- CodeQL default setup has been configured since 2026-10-23 (actions, JavaScript/TypeScript, Python; pull requests, `main` and weekly).
- Secret scanning and push protection are enabled.
- 0 code-scanning alerts are open out of 22 (7 fixed, 15 dismissed).
- 0 secret-scanning alerts have been raised.

The doc now describes those settings and how to re-check them. INF-18 is recorded as superseded (founder decision 2026-10-30), because the repository is public. Documentation only; no setting, workflow, ruleset or guard changed.

**Not established.** The settings were read once, by hand. Nothing in CI checks them, so they can drift from this record without a failing check. CodeQL is still advisory: the ruleset does not require it.
