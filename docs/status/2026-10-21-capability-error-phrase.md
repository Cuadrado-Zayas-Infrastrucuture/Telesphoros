# The API's capability error no longer carries the issuer's alarm phrase (DATA-01 follow-up, local)

Date: 2026-10-21

`CapabilityIssueError` (`apps/backend/src/issuer/capability-issuer.port.ts`) built its message as `Capability not issued: <reason>`, the phrase `issuer.tf`'s two metric filters count on the issuer side. Nothing in the API logs an error message today, so no alarm was double counted, but a future `logger.error(err.message)` would have been. The message is now `Capability issuance failed: <reason>` (`Invalid token` is unchanged), and `IssuerCore`'s own log literals, `issuer.tf` and `issuer.guard.test.mjs` are untouched. `apps/backend/src/issuer/alarm-phrase.spec.ts` pins two things: no `CapabilityIssueError` message carries the phrase for any of the five reasons with any detail, and no non-test source under `apps/backend/src` other than `issuer-core.ts` writes it (comment lines are skipped).

Not covered: the scan reads line text, so a phrase assembled at run time is not seen; only the error's own message is checked by building it. Local only: nothing is pushed, nothing applied in AWS.
