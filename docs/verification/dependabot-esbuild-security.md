# Dependabot esbuild security update repair (2026-10-17)

## Established cause

[Dependabot run 39065732323](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/39065732323), job 1633384236 at main `e19e61a`, failed with `security_update_not_possible`. The updater identified esbuild 0.27.7 as the latest resolvable release and 0.28.1 as the earliest fix. Complete native output and status are retained privately in the originating chat's `work/dependabot-investigation` directory.

The [upstream advisory GHSA-g7r4-m6w7-qqqr](https://github.com/evanw/esbuild/security/advisories/GHSA-g7r4-m6w7-qqqr) covers Windows development-server file traversal and identifies 0.28.1 as patched. The actual baseline lockfile audit reproduces the finding. `tsup 8.5.1` requires esbuild `^0.27.0`, which excludes that fix; the installed Vite peer range already accepts `^0.28.0`. npm registry metadata confirms no tsup 8 release widens that range. This is dependency resolution refusal, not a GitHub credential, runner or schedule failure.

## Repair and scope

A workspace pnpm override requires esbuild `^0.28.1`. The regenerated lockfile resolves esbuild and all its platform binaries to 0.28.2. All non-esbuild package versions, build-tool versions, build-script allowlist, package-manager pin and Node pin remain unchanged. The override allows subsequent compatible 0.28 security patches. No security advisory is ignored or dismissed.

After frozen installation, the same native `pnpm audit --json` reports no esbuild advisory. Its exit remains 1 because the separate `sprintf-js` finding GHSA-hp3w-g68c-fv3c has no published patched version in the registry/advisory data. This repair does not resolve that separate issue or claim the whole audit is green. Original before/after JSON and exits are preserved.

Local verification passed the affected existing compiler consumers: all workspace typechecks/lint/builds, CI controls, frontend tests, all library/SMART/notifier tests and the full worker suite against a fresh authenticated PostgreSQL 16 cluster and Moto. PostgreSQL fsync, synchronous_commit and full_page_writes remain on. All 137 CI controls, 39 native frontend controls plus 364 frontend unit tests, 285 library/SMART/notifier tests and all 123 real-PostgreSQL worker tests passed with no selected skips. Measured counts and preservation receipts are recorded in Obsidian.

The exact Windows traversal exploit is not exercised on this Mac. Patched-version acceptance relies on the upstream security release; local checks establish dependency resolution and existing build/test compatibility. Hosted Dependabot and all-six CI acceptance at this candidate remain unrun. The old failed run cannot become successful from an unmerged local change; default-branch merge and a fresh server-side scan are separate steps. Current main's earlier green CI is historical evidence, not acceptance of this dependency update.

## Preserved controls and next gate

Dependabot configuration, grouping and schedule; all six required checks; CI job/profile coverage; watchdog and shared deadline; and test assertions/timeouts are unchanged. The source change is on `fix/dependabot-esbuild-security` off current main. Main, existing feature/fix refs, personal notes, Home, legacy/recovery archives and worktrees are preserved. No publication, PR merge, deployment or production access occurs in this repair. Before merging, open/review the dedicated PR and require all six checks plus fresh dependency security results.
