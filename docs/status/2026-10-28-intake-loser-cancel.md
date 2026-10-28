# Fix: a duplicate upload on another API task no longer cancels the winner's (local)

Date: 2026-10-28

Found by the 2026-10-27 audit (U1).

**The problem.**
- Each API task keeps its own set of active uploads, so across tasks only the database decides who writes. When two PUTs for the same attempt reached two tasks and both read it as `declared`, the one that lost `beginAttempt` threw a conflict and its cleanup ran `cancelAttempt`.
- `cancelAttempt` is not tied to a writer, so it marked the winner's running transfer `cancelling`. The winner's upload was then lost, or a stored object was left uncommitted.
- Reproduced on PostgreSQL with two applications on one database: after the loser's 409 the winner's attempt read `cancelling` with `cancel_requested`.

**The fix.** The cleanup in `intake()` runs only for the request that began the attempt (a local `began` flag). A request that lost the begin answers 409 and touches nothing. `cancelAttempt` itself is unchanged: the person's own cancel must still reach a running transfer, and so must the cancel after a refused commit.

**The tests.**
- `test/reports-intake-duplicate.e2e-spec.ts` (PostgreSQL tiers): the winner begins on one app and holds back its bytes; the loser on the other app reads the attempt as `declared` (the window between two tasks, made exact rather than raced) and gets 409; the attempt stays `intaking` with no cancel request, and the winner then commits.
- Red before the fix; removing the guard turns it red again. A request that began and then failed validation still closes its attempt (the existing refusal tests in `reports-intake-organization.e2e-spec.ts`).

Not verified in AWS.
