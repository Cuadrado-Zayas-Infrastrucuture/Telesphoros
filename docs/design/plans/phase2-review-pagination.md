# Phase 2 bounded review lists

Second slice of the founder-approved Phase 2 closure sequence, continued on 2026-10-10 after verifying PR #51 merged. Base: fresh main `5d0fd9282d6bb2242efaa8e8852949a9338e571b`. One draft PR; batching follows separately after merge verification.

## Problem and contract

Evaluation and dispute lists return every matching record. Dispute status filtering happens after retrieval, and the operations screen assumes arrays. Use the existing `page/pageSize` contract (page 1, 20 records by default; 100 maximum) and `{ data, meta }` envelope. Apply filters and sequence ordering before SQL bounds; counts describe all matching tenant records, including on empty pages. Reject invalid pages, unsafe offsets, repeated parameters and unknown fields.

Update every actual list consumer, including the development operations screen and browser fixtures. Add visible previous/next controls, maintain page position and displayed records on a failed request, and clear prior selection/confirmation when successfully moving pages. Existing dispute-impact cursor pagination stays separate.

## Safety boundary

Public dispute pages must never replace the complete internal dispute read used by clinical overlays, commit-time checks and historical advisories. Test an active dispute after 20 dismissed records: it remains clinically held despite being absent from page 1. No clinical engine or adapter changes, schema/migrations, knowledge/capture changes, AWS/DNS, live data, deployment, spend or ruleset changes. Evaluation context batching and the live image-check enforcement gap remain follow-ups.

## Verification

Shared query schemas; application-role PostgreSQL page/count/order/filter/current-state tests; explicit tenant predicates tested with a superuser that bypasses RLS; real HTTP pagination/validation plus existing correction/dispute suites; UI failed/busy/empty navigation tests; mobile/desktop keyboard/browser checks; lint, types, build and chunk guards. Deliberate defects must fail assertions, then source restoration and passing controls must be verified. PR CI supplies the full real PostgreSQL/S3 protocol/image/security checks.

## Review gate

Lists intentionally change from arrays to the existing pagination envelope. Offset pages are independent requests, not a cross-request frozen snapshot; concurrent appends/corrections/decisions can change subsequent pages. SQL count and page membership share one statement snapshot. Exact totals still scan matching identifiers. Per-record context reads remain until the separate batching slice. Founder decides merge and eventual whole-Phase-2 acceptance.
