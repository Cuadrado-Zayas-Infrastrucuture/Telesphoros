# Test application listener ownership

## Cause and repair

The test helper awaited `app.listen(0)` but left its address unspecified. On the
verified macOS host, that binds IPv6 wildcard `::`. A second HTTP server can bind
the same port on IPv4 loopback `127.0.0.1`. Supertest addresses an already-running
wildcard server over IPv4 loopback, so its request can reach the second server.
Waiting for initialization or retrying a request does not establish port ownership.

A two-server reproduction returned 404 with zero requests received by the intended
server and one received by the competing server. Binding the intended server to
`127.0.0.1` instead refused the competitor with `EADDRINUSE` and returned 200 from
the intended server. The installed Supertest source and lockfile match the prior
candidate; no dependency change is needed.

`createTestApp` now binds its one persistent listener explicitly to `127.0.0.1`.
Production bootstrap and route configuration are unchanged. The historical
untraced failure did not identify the responding server, so it cannot independently
prove which process answered that particular request. The new regression proves
the address-ownership defect and reproduces the same 404 using the real helper.

## Permanent regression

`test/test-app-listener.e2e-spec.ts` starts the real application and a competing
HTTP server. A positive control first proves that the competitor can bind and
answer on its own loopback port. It then attempts to bind the application's port.
The test requires the competing bind to fail specifically with `EADDRINUSE`, the
application to own IPv4 loopback, and the first health request to return exactly
`{ status: 'ok' }` without reaching the competitor. Both listeners close in cleanup.

Before the helper change, this regression failed with `expected 200 "OK", got 404
"Not Found"`. Afterward, the regression and all eight unchanged health cases
passed (9/9). The address assertion also refuses wildcard binding on platforms
that prevent the simultaneous bind by default.

## Verification scope

Fresh complete checks and their native exits are retained in the originating
Codex workspace's `work/health404-fix` directory and summarized by its delivery
report. This repair changes test listener binding only: Terraform backend source
wiring, the eight health cases, production code, error envelopes, deadlines,
service-profile selection and dependencies are preserved. Hosted Linux acceptance
and publication remain separate gates. Nothing is deployed or applied to AWS.
