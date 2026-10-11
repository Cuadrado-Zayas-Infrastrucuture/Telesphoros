# Synthetic OpenEMR SMART pilot

This is a separately runnable development harness in `packages/smart-pilot`, never a production API module. It launches a standalone viewer from a real OpenEMR chart, verifies OAuth/PKCE and signed clinician identity, and reads exact patient-bound FHIR data. It displays synthetic consent/genomic fixtures only. It never invokes clinical evaluation, an LLM, prescribing or EHR writeback.

## Start

Prerequisites: Node >=22, pnpm matching the workspace, Docker running, and localhost ports 8301/8767 available. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm demo:smart:setup
pnpm demo:smart
```

The dedicated `telesphoros-remastered-smart-synthetic` Docker project generates credentials under `packages/smart-pilot/openemr/.runtime/` (directory 0700, files 0600). Runtime files are ignored and excluded from the image build context. Provisioning refuses a database with non-pilot patients or conflicting patient identities. MariaDB has no published port; OpenEMR binds `127.0.0.1:8301`, and the viewer binds `127.0.0.1:8767`. No production environment file is loaded. `NODE_ENV=production` refuses startup.

Open [the isolated EHR](http://127.0.0.1:8301/interface/login/login.php). The user is `synthetic-admin`; retrieve its password locally from the generated runtime `docker.env` entry `PILOT_ADMIN_PASSWORD`. Never paste it into chat or reports. The test clinician uses the deliberately invalid NPI `0000000000` to produce a Practitioner identity; it represents no real clinician.

1. Search **Synthetic**, then open **Pilot 1, Synthetic**.
2. Select **Open synthetic PGx review in a new tab** in the custom module section. Use this action, not the stock iframe SMART card.
3. Authenticate in OpenEMR OAuth and authorize Patient Read and MedicationRequest Read/Search.
4. Confirm **Synthetic context verified**, the correct patient and practitioner, medication context, and a clearly labeled genomic fixture. Clinical recommendations remain disabled.
5. Repeat with **Pilot 2, Synthetic**. Confirm **Genomic consent required**, with genomic content withheld.

Changing chart patients requires a fresh launch. The extension rejects stale links whose patient differs from the active EHR chart. The viewer removes the session fragment immediately; no token is stored in browser storage. Reloading requires a new launch. Sessions expire after at most 15 minutes or earlier token expiry and disappear on server restart.

## Boundaries

| Boundary | Control |
|---|---|
| Issuer and tenant | Fixed server-side registration; only loopback endpoints on the pinned issuer origin; caller tenant/scope overrides rejected |
| Clinician | RS256 signature, issuer, audience, expiry, nonce and clinician resource shape validated |
| Launch/session | Per-launch PKCE, state, browser cookie binding and separate bounded in-memory sessions |
| Patient | Exact synthetic registration plus matching EHR synthetic marker; no demographic matching |
| Medications | GET only; resource/subject validation; same-patient pagination; time, size, page and record limits; uncertain/uncoded records visible |
| Consent/genomics | Engineering fixtures only; no consent or interpretable fixture means no genomic display |
| Deployment | Separate development package and viewer; no production API or UI imports; no AWS changes |

OAuth token exchange is the only outbound POST. Synthetic provisioning is a separate CLI step; the running connector has no write routes, refresh-token workflow, report storage, feedback persistence or clinical recommendation generation. The FHIR display adapter belongs to the pilot: Remastered's FHIR/CDS Hooks production integration is not implemented by this slice.

## OpenEMR compatibility

The derived image pins `openemr/openemr:8.4.1@sha256:9322d489069bbfc1664515f25729f3ccef8ec1738c62a55f45588b7376f6f52c`. It checks the original `BearerTokenAuthorizationStrategy.php` hash and exact call sites before applying two fixes:

- Pass the user's UUID string, not its numeric local ID, into UUID validation.
- Convert the patient UUID string to binary at the database lookup boundary.

Build-time probes verify those conversions and preserve rejection of a denied patient. No running server source is edited. Updates to the pinned source intentionally require review.

The adapter accepts OpenEMR's additional non-resource `nonce` scope, a missing JWT key ID only when its pinned JWKS contains one eligible RSA signing key, absolute Practitioner/PractitionerRole references, and `collection` medication bundles alongside `searchset`. Signature and patient checks remain mandatory. `Person` identities and ambiguous signing keys are refused.

## Verification

```sh
pnpm --filter @telesphoros/smart-pilot typecheck
pnpm --filter @telesphoros/smart-pilot lint
pnpm --filter @telesphoros/smart-pilot test
pnpm --filter @telesphoros/smart-pilot build
pnpm --filter @telesphoros/smart-pilot test:ehr-guard
pnpm --filter @telesphoros/smart-pilot test:browser
```

The optional `test:ehr-guard` runs the actual provisioning predicate on a connection-local temporary MariaDB table, including NULL/empty/unregistered refusal and valid fixture controls. It never changes persistent patient records.

The optional browser smoke requires the installed gstack browse binary at `~/.agents/skills/gstack/browse/dist/browse`, the provisioned EHR, and the running viewer. It captures generated credentials only in memory and withholds sensitive browser diagnostics. It opens the observed chart link in a managed tab because the driver does not track native `noopener` popups. It clears the stale local OAuth cookie for this test browser session (cookies are not port-scoped); do not use this test browser concurrently with another localhost OpenEMR instance. Screenshots and an aggregate verification JSON remain in the ignored runtime directory.

The HTTP fixture is test-only and is not exposed by the executable. Workspace `pnpm test`, lint, typecheck and build include this package. Real EHR browser verification is separately recorded in [verification](../verification/openemr-smart-pilot.md).

## Stop and production prerequisites

Stop the Node viewer with Ctrl-C, then stop the dedicated EHR without deleting synthetic volumes:

```sh
docker compose --env-file packages/smart-pilot/openemr/.runtime/docker.env -f packages/smart-pilot/openemr/compose.yml stop
```

This pilot is local HTTP with memory-only sessions. Production requires separately reviewed TLS, durable session/audit/consent integration, user/organization mappings and clinical validation/release approval. Do not mount this harness in the production API. The original repository was deleted; the port targets Telesphoros-Remastered from a fresh main branch and carries no legacy history or gateway dependencies.
