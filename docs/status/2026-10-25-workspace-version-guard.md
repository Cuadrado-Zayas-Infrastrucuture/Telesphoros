# One version range per dependency across the workspace (2026-10-25)

Date: 2026-10-25

**Implemented (tooling only; no runtime, CI workflow or dependency change).** `pnpm test` now runs `scripts/workspace-build/versions.test.cjs`. It reads the root manifest and every package that `pnpm-workspace.yaml` names (11 manifests today, including `infrastructure/lambda/*`) and fails in three cases: an external dependency has more than one version range, a workspace package is referenced by anything other than `workspace:*`, or the root has runtime `dependencies`. Today the workspace has 25 dependencies that appear in more than one manifest, with no drift, so the check lands green. It stops two packages from building against different releases of one library without anyone choosing that. This came out of the create-t3-app comparison and stands in for `@manypkg/cli`, which has had no release since 2025-08-28; the in-repo guard adds no dependency (founder decision 2026-10-24).

**Fails closed.** The guard reads only the `dir/*` pattern form. Any other form, or a pattern that matches no package, is reported, so a package cannot drop out of the check unnoticed. A floor on manifests read and dependencies compared means an empty read cannot pass. `peerDependencies` are not compared, because a peer range is meant to be wider.

**Tests, red first.** 11 cases: the real workspace (with the floor); refusals for two ranges across packages, two ranges inside one package, a workspace package referenced by a range, `workspace:` for an unknown name, root `dependencies`, an unreadable pattern and a pattern matching nothing; plus controls for consistent manifests, the packages-list reader and fixture discovery. Defect injection on the real tree: changing `apps/worker`'s `zod` to `^4.5.0` turned the real-workspace test red, naming every manifest and its range; restoring it turned it green.

**Limits.** Ranges are compared as written: `^4.6.7` and `~4.6.7` count as different, by design. The lockfile is not read; `pnpm install --frozen-lockfile` remains what pins resolved versions.
