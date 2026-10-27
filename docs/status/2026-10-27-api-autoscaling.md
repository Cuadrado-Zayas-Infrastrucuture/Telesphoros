# Infrastructure: the API scales on CPU between a floor and a ceiling, and the connection budget counts the ceiling

Date: 2026-10-27

From the 2026-10-27 MVP architecture review (gap G-C): Terraform had no autoscaling, so the API ran a fixed `api_desired_count` and a
burst could only be met by an apply. NOT APPLIED.

Changed: `api-autoscaling.tf` registers the API service as an Application Auto Scaling target between `api_desired_count` (floor) and a
new `api_max_count` (ceiling; default null, which keeps the floor and the ceiling equal, so nothing scales and the default plan only adds the
target). With a ceiling above the floor, a target-tracking policy holds the service's average CPU at `api_scale_cpu_target` (default 60%),
scale-out cooldown 60 s, scale-in cooldown 300 s. The API service now ignores `desired_count` changes, so an apply no longer resets a
scale-out; per the RegisterScalableTarget documentation, updating the target moves the running count inside the new bounds, so a raised
floor still takes effect. `database-connections.tf` counts the API at `local.api_max_tasks` (the ceiling), in the instance budget and in
each login's own demand (`login_connection_demand`, app and verifier), so a ceiling the instance or a login limit cannot serve is refused at
plan time. With the current login limits (app 50, verifier 20) and the 200% deploy peak, that allows at most 2 API tasks at
`api_db_pool_max` 10, or 3 at 5; a higher ceiling needs those limits raised in `provision-logins.ts` on purpose.

Proved: `api-autoscaling.guard.test.mjs` (in `pnpm test:infra`) checks the variable bounds, the target's floor and ceiling, the policy's
gate, metric and scale-in, the service's `ignore_changes`, and the budget's and each API login's use of the ceiling; each of its eleven
rules was seen to fail on a broken copy, and the guard failed before the Terraform existed. The connection guard now expects the ceiling.
`profiles.tftest.hcl` adds six plan runs (target held by default with no policy; policy with a ceiling, whose login demand counts it; a
ceiling under the floor refused; a ceiling over the app login's limit refused; the budget counts the ceiling, 63; a ceiling over the budget
refused although the floor fits). Those runs need the pinned Terraform and its providers.

Not changed: the worker and the issuer (no queue-depth metric to scale the worker on, and one worker task is enough, `docs/ops/jobs.md`;
the issuer is off), deployment percentages, pool sizes, the running-task alarm (it still fires below the floor), application code, any AWS
resource. Not verified: scaling behaviour on a live service; that the applying role may create the Application Auto Scaling
service-linked role.
