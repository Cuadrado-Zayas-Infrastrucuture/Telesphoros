# Shared dependency build ownership

Approved 2026-10-11: fix the parallel build race in a separate draft PR from main (`db96b1e`). PR #71 stays separate.

Backend and SMART pre-hooks both run clean builds of shared-types while pnpm's recursive scheduler runs consumers concurrently. That hidden work is outside the scheduler's dependency graph; one clean can remove files another builder or reader needs.

A workspace launcher will build the prerequisite libraries once before typecheck/test and mark only its child invocation as prepared. The existing package hooks will skip only their redundant prerequisite work in that invocation. Recursive build uses pnpm's existing topological build graph without nested builds. Standalone package commands still build their prerequisites. Checks, package parallelism, cleaning and failure exit codes stay intact. Independent top-level commands in the same checkout are not coordinated; use separate worktrees for simultaneous workflows.

Verify the main-branch failure with bounded attempts, prepare-before-read ordering, one producer per dependency, standalone hooks, build/check error propagation, and unchanged parallel workspace typecheck/build plus affected package tests. Add the regression checks to the normal test command; deliberately remove the prepared marker and require a regression failure. No retention, clinical gates, production code/data, infrastructure, deployment or test-deadline changes. No founder decision remains open within this scope.
