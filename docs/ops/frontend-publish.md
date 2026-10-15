# Publishing the frontend (FD-7 slice 2)

**Status: the script and its tests exist. It has never uploaded to a real bucket, and nothing in AWS exists yet.** It is for the synthetic staged environment and runs from a person's shell:
CI holds no cloud credentials and publishes nothing. Plan: [fd7-staged-synthetic-deploy.md](../design/plans/fd7-staged-synthetic-deploy.md). The hosting itself is described in [domains-and-hosting.md](domains-and-hosting.md).

## What it does

`scripts/staging/publish-frontend.sh` takes the settings from the environment, builds the normal production frontend, and uploads it to the web bucket.
**The default is a dry run**: it validates, builds, stages, prints the exact commands it would run, and uploads nothing. `--yes` uploads.

| Environment variable | Source |
| --- | --- |
| `WEB_BUCKET` | `terraform output -raw web_bucket` |
| `VITE_OIDC_AUTHORITY` | `terraform output -raw cognito_issuer` |
| `VITE_OIDC_CLIENT_ID` | `terraform output -raw cognito_app_client_id` |
| `VITE_COGNITO_DOMAIN` | `terraform output -raw cognito_sign_in_domain` |
| `VITE_API_BASE_URL` | `https://api.<web_domain>`, **no path** (the app appends `/api/v1`; a path would be doubled) |
| `WEB_DISTRIBUTION_ID` (optional) | `terraform output -raw web_distribution_id`; when set, an invalidation of `/*` is requested after the upload |

None of the `VITE_*` values is secret: they are compiled into the public bundle.

```sh
# from the repository root, on the reviewed commit, with the values above exported
scripts/staging/publish-frontend.sh          # dry run: read what it says
scripts/staging/publish-frontend.sh --yes    # upload (AWS CLI v2 and credentials for the account that owns the bucket)
```

## What it refuses

Before building, it stops on: a missing setting; whitespace; a placeholder (the `.env.example` values, `example`, `<...>`); anything that is not `https://`; `localhost` or a loopback address;
a path on `VITE_API_BASE_URL`; a bucket given as `s3://...`; a malformed distribution id; and any of `VITE_LOCAL_STORAGE_INTAKE`, `VITE_LOCAL_REVIEW_S`, `VITE_REPORT_STORAGE_ORIGINS` being set
(they belong to local and end-to-end builds). The accepted values are also accepted by the application's own `loadAuthConfig` in production mode (a test hands them to it).

After building, it copies the build into a directory of its own **without source maps and without Vite's build manifest (`.vite/`)**, then stops if a source map is still there, if any other hidden file is there,
if `index.html` is missing, or if the bundle does not contain the API address and the sign-in authority it was told to use (a build made without the settings would show "Telesphoros cannot start").
`vite.config.ts` sets `sourcemap: true`, so the build always writes `*.map` files; the H1 rule is that they are never public. The compiled files still end with a `sourceMappingURL` comment, so a browser's developer tools
may ask for a map and get an error: that is expected and harmless.

## Order of the upload

1. `assets/` (hashed file names) with `Cache-Control: public,max-age=31536000,immutable`.
2. Everything else except `index.html`, with `no-cache`.
3. `index.html` last, `no-cache`, so a visitor never gets a page that names assets which are not there yet.
4. The optional invalidation.
5. A listing of the bucket; the script fails if any `*.map` is in it.

**Nothing is deleted**: the bucket is versioned and open tabs may still need the previous hashed assets, so old files stay. Remove one by hand if you must.
The distribution uses the managed `CachingDisabled` policy, so CloudFront keeps no copy and the invalidation changes nothing today; it is there so the script stays correct if caching is ever turned on.
The script does not pause for confirmation, so check the account first (`aws sts get-caller-identity`); it prints the account and identity again as the upload starts.

## What a hosted build shows

The Reports dashboard (`/reports`) is mounted only in the owned-storage build, which is restricted to a loopback address, and this script refuses that build's flag. **A published build therefore has the upload page
(`/reports/upload`) and no Reports dashboard.** That is a product decision, not part of this slice; the staged environment shows what exists.

## Tests

`scripts/staging/publish-frontend.test.mjs` (run by `pnpm test:infra`) runs the script against a fixture build with a stand-in `aws` that records its arguments: the dry run calls nothing; `--yes` calls in the order above;
every refusal above fails before any call; with the map exclusion removed the script refuses; a map already in the bucket fails the run. A real production build through the dry run (23 files, 13 source maps left out, settings found in the bundle) was also
run once by hand. **Not verified:** that the real AWS CLI accepts these arguments against a real bucket, that the person's role may write to the bucket, the content types S3 assigns, or that the published site loads behind CloudFront
(CSP, deep links, sign-in, upload): that is the staged-environment acceptance.
