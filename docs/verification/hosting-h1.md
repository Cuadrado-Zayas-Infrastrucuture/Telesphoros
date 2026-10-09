# H1 frontend configuration verification

Date: 2026-10-08 (America/Puerto_Rico). Base: `e8b302a99d220514bfa7e907d9d15aab06b1131f`.
The private repository's main/PR collection, relevant Terraform history, frontend auth caller,
BrowserRouter routes and current CI configuration were read before implementation.
Local files are a materialized source subset, not an authenticated Git checkout.

## Passed locally

| Check | Evidence |
| --- | --- |
| Whole Terraform root formatting | `terraform fmt -check -recursive -diff`, exit 0 |
| Whole root provider-schema validation | `terraform validate`, exit 0; no AWS credentials/backend used |
| Provider negative control | Added an unsupported argument inside the new S3 resource; schema rejected it with `Unsupported argument`; restored byte-identical source and validation passed |
| Infrastructure guards | 20 passed, zero skipped; 9 new web tests plus 11 existing infrastructure tests |
| CI configuration guards | 13 passed, zero skipped; no workflow change |
| Defect injection | 39 weakened configurations/routing variants each failed a web test; both edited files restored byte-for-byte; clean final guards and formatting re-run passed |
| Provider locks | Signed checksums recorded for both Linux amd64 (CI) and Darwin arm64 |

Tools: Terraform **1.16.5**, AWS provider **6.68.0**, archive provider **2.8.1**,
Node **22.22.0** for the final guards. Provider initialization used `-backend=false`.
The committed `.terraform.lock.hcl` pins the tested providers; CI does not apply or deploy.

Commands from the repository root:

```sh
node --test infrastructure/terraform/guard.test.mjs .github/ci/guard.test.mjs
terraform -chdir=infrastructure/terraform fmt -check -recursive -diff
terraform -chdir=infrastructure/terraform init -backend=false -input=false -lockfile=readonly
terraform -chdir=infrastructure/terraform validate
```

## Defects caught

Each change was applied alone against a passing baseline and then undone:

- Enabled default; ungated bucket count; forced bucket destruction.
- Each of the four public-access controls; ownership; versioning; encryption.
- Unsigned OAC; wrong signing protocol; wildcard read grant; missing distribution binding;
  wrong secure-transport condition; detached OAC.
- Wrong certificate region/provider; plaintext viewer policy; old TLS; POST allowed; caching enabled.
- Inline scripts; framing; referrer leakage; HSTS preload/subdomains; browser permissions.
- Wrong callback/logout paths; missing upload-origin precondition.
- Request-controlled redirect host; wrong redirect status; lost repeated query values;
  wrong shell target; rewriting file extensions, API paths, assets or POST requests.

These are text/VM checks, not a general HCL policy parser or an AWS security attestation.
Runtime routing tests cover synthetic CloudFront event shapes including encoded values,
repeated/empty query values, uppercase aliases, auth routes, unknown app navigation,
missing assets, API paths, unrelated hosts, GET/HEAD and POST.

## Failures isolated during setup

Sandbox DNS initially blocked provider downloads; approved network execution fetched signed providers.
Local provider socket startup was also blocked by the sandbox; schema validation passed with permission
to launch those local subprocesses. Neither step connected to an AWS account.
The first CI-guard attempt lacked files in the materialized subset; fetching their pinned source
resolved it. One formatting check overlapped the schema negative control and saw the intentional
bad argument; after restoration the final sequential checks passed. No weakening remains in delivered files.

## Not proven

No AWS `plan` or `apply`, live resource state/permissions, DNS records, certificate issuance,
CloudFront edge execution, costs, Vercel build or browser deployment has been tested.
Terraform validation does not evaluate an actual enablement plan or prove zero resources in its state;
the gate is checked against resource/data declarations. Existing backend, database and S3 test tiers
were not re-run locally because this PR changes no application/schema/permission code. Required CI
still runs all three backend tiers and browser tests; its result must be inspected before merge.

Live CSP compatibility, Cognito redirects, denied direct S3 access and API/report CORS require the
staged synthetic checks in the [DNS checklist](../ops/domains-and-hosting.md). The current upload UI
is still a synthetic stub; frontend hosting does not finish that integration. No clinical or training
flags, production gates, existing report retention, ledger rules or email records were changed.
