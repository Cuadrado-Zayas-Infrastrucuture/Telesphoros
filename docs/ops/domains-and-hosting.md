# Company and product hosting (H1, configuration only)

Founder decision: company landing page on Vercel; Telesphoros on AWS. Both DNS zones are
in Jan's one Cloudflare account, administered by Jan. Google provides company email.
This is **not deployment approval**. No DNS account, AWS account or Vercel project has
been inspected or changed by this implementation. Company source/project is still needed.

## Address map

| Address | Destination | Status |
| --- | --- | --- |
| `cuadradozayasinfrastructure.com` | Company Vercel project | Confirm exact zone/project before cutover |
| `www.cuadradozayasinfrastructure.com` | Redirect to company apex in Vercel | Prepare in the company project, not this repository |
| `app.telesphoros.app` | Private frontend S3 origin through CloudFront | H1 Terraform, disabled by default |
| `telesphoros.app`, `www.telesphoros.app` | 301 to `app.telesphoros.app`, retaining path/query | Same CloudFront distribution and certificate |
| `api.telesphoros.app` | AWS API host | F3a (edge: certificate, load balancer, firewall) written, disabled by default; compute is F3b; see [api-hosting.md](api-hosting.md). No DNS record until a healthy service exists |

Cloudflare remains authoritative. Use DNS-only for CloudFront records to avoid chaining
CDN proxies. Use the Vercel project's **actual displayed** A/CNAME/TXT values; do not copy
generic addresses from a tutorial. Existing Google MX, SPF, DKIM, DMARC and verification
records stay in place. This change neither configures SES nor moves human mail to SES.

## What H1 adds

`infrastructure/terraform/web.tf` adds optional frontend resources to the existing root.
`enable_web_hosting = false` is the default: all new resource/data counts are zero.
Enabling it is **not safe authorization to apply the rest of this root**: the existing
database, storage, Cognito and notifier resources are still part of a whole-root plan.

- A distinct versioned, SSE-S3-encrypted bucket, public access blocked and ownership enforced.
  It is for public JavaScript/CSS/images only, never reports, runtime secrets or patient data.
  `force_destroy = false`; no version-expiration policy is added.
- CloudFront OAC signs every origin request. The bucket grants only `GetObject` to that
  distribution's exact ARN and denies plain HTTP. There is no S3 website endpoint or public ACL.
- An ACM DNS-validated certificate in `us-east-1`, covering app, apex and www. Other
  existing services remain in their configured regions.
- HTTPS redirect, TLS 1.2 minimum, no shell caching, and GET/HEAD only. All static files
  currently use the disabled-cache policy too; asset cache optimization is a later change.
- Viewer-request routing redirects apex/www to a fixed app host. On the app host, GET/HEAD
  paths without a final-component dot rewrite to `index.html`, excluding `/api` and `/assets`.
  This supports existing BrowserRouter routes and its not-found page; missing files keep their
  origin errors. No 403/404-to-200 error mapping disguises a broken origin.
- CSP permits self-hosted scripts and explicit API, Cognito and regional report-upload
  endpoints. Existing React inline styles require `style-src 'unsafe-inline'`; inline
  scripts/eval remain forbidden. Referrers are suppressed, framing denied, and HSTS starts
  at one day without subdomains or preload. The browser/Cognito/S3 path needs a live check
  before release; schema/text tests do not prove compatibility in an actual deployment.

No CloudFront access logging is configured here: auth query strings must not enter logs.
Any H2 WAF/CloudTrail/observability plan needs its own redaction and retention review.

## Later deployment and DNS checklist (not executed)

1. Export both Cloudflare zones and record the old web A/AAAA/CNAME targets and proxy
   settings for rollback. Confirm no existing wildcard or duplicate web record conflicts.
   Preserve all Google/email verification records. Nameservers do not change.
2. Review the AWS BAA, encrypted/locked remote state, OIDC deployment roles, the full-root
   Terraform plan and costs before any apply. These existing first-apply requirements remain.
   H2 API hosting, WAF and the application's own alarms remain separate work (the CloudTrail audit trail is written separately: [audit-trail.md](audit-trail.md)).
   Do not create the break-glass role ahead of its audit prerequisites.
3. Choose the environment and confirm `web_domain`. To enable H1, supply the exact
   `https://app.telesphoros.app/auth/callback` callback, `/signed-out` logout and
   `https://app.telesphoros.app` report CORS origin. A resource precondition rejects mismatch.
   This PR does not change existing variable values or weaken production gates.
4. Request/validate ACM before switching web traffic. During a later approved apply,
   certificate validation waits for Jan's manual CNAMEs. Obtain the requested records from
   the ACM console while it waits; do not depend on end-of-apply outputs to unblock that wait.
   Add each exact validation CNAME as DNS-only and keep it for renewal. After success,
   `web_validation_cnames` records the same certificate information.
5. Build with the real Cognito settings and `VITE_API_BASE_URL=https://api.telesphoros.app`.
   `AuthProvider` already appends `/api/v1/me`; adding that prefix to the base would double it.
   The upload form still uses a synthetic browser-only stub; hosting does not integrate it
   with the existing upload API. Vite settings are public; no secret may
   be bundled. Exclude generated `*.map` source maps from the public upload. The synthetic
   staging upload script and its runbook are [frontend-publish.md](frontend-publish.md); there
   is still no release workflow, account role or artifact.
6. Test a staged deployment with synthetic data: TLS, headers, BrowserRouter deep links,
   callback/logout, API CORS, presigned uploads, denied direct S3 access, missing-asset errors
   and apex/www redirects. The app is not usable until the H2 API and auth dependencies exist.
7. Only after separate cutover approval, set Cloudflare DNS-only CNAMEs for `app` and `www`
   to `web_cloudfront_domain`, and a flattened apex CNAME to that same target. Certificate
   validation records are separate from traffic records. Do not publish an API record until
   H2 supplies a tested target. Verify both A and AAAA resolution, TLS and redirect behavior.
8. In the company Vercel project, test its preview first, attach apex/www, and use its
   project-specific DNS instructions. Check links, canonical redirect, HTTPS and mail delivery.
9. Rollback web routing by restoring the saved web targets/proxy settings. Restore a known
   frontend artifact/version if needed. Do not delete certificate-validation or mail records
   as part of rollback, and do not destroy infrastructure to roll back traffic.

## Verification and limits

The existing `pnpm test:infra` command imports the new web guard suite. Guards check scoped
Terraform text and execute the routing function in a JavaScript VM with synthetic requests.
Terraform formatting and provider-schema validation cover the whole root without credentials.
Defect injection and exact tool versions are recorded in [H1 verification](../verification/hosting-h1.md).
No AWS plan/apply, Vercel build, DNS cutover, live CSP/login/upload or cost estimate has been verified.

## Provider references

- [Vercel custom domains](https://vercel.com/docs/domains/working-with-domains/add-a-domain):
  project-specific DNS values; retaining external DNS and mail records.
- [Cloudflare proxy use cases](https://developers.cloudflare.com/dns/proxy-status/use-cases/):
  DNS-only for another CDN to avoid proxy conflicts.
- [CloudFront certificate requirements](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-procedures.html):
  ACM in `us-east-1` and domain coverage.
- [CloudFront Functions event structure](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html):
  query values and multiValue representation. Local tests preserve the event representation;
  actual edge behavior still requires the staged check above.
