# Patient identifiers and the report link (operator notes)

Added by M2.1b. A clinic can attach to a patient the identifiers it already uses (for example a medical record number); a second person can then verify a
report's patient by matching the number printed on the report. Design and the reasoning: [the M2.1b design note](../design/plans/m2-1b-identifiers-and-patient-link.md).
Synthetic data only; nothing here has been applied in AWS.

## What is stored, and what is not

- **Never the number.** The application receives the value once, normalizes it (Unicode NFKC, trimmed, white space collapsed, upper case; **no
  punctuation removed**), and stores `HMAC-SHA-256(orgKey, system + 0x00 + value)`. No response, log line, security event or ledger record carries the value
  or the digest; a test scans every table of the database for it.
- **One key per organization, derived, not stored.** `orgKey = HKDF-SHA-256(master, salt "telesphoros/patient-identifier/v1", info "org:" + tenantId)`. The
  same number in two organizations (or two systems) is two different stored values; nothing can be matched across organizations. Onboarding a clinic creates
  no secret.
- **One master secret**, `IDENTIFIER_DIGEST_KEY` (64 hex characters, `openssl rand -hex 32`), in the Secrets Manager secret `.../api/identifier-digest-key`
  ([api-hosting.md](api-hosting.md)). The service refuses to start in production without it. Development and tests use a fixed, non-secret key.

## Key custody

| Question | Answer |
| --- | --- |
| Who holds the master? | The Secrets Manager secret, readable by the service's execution role only; never in Terraform state, a log or a repository. Set it once by hand before the first service start |
| Why is a leaked table not enough? | A record number has little entropy; with the key an attacker could test guesses. Without it the digests cannot be matched. The digest is therefore protected like patient data (row-level security, never returned, never logged) |
| Can the master be rotated? | **Not casually.** Raw numbers are not kept, so replacing the master makes every stored identifier unmatchable until it is entered again. Each row carries `key_version` (1 today) for the day this is needed |
| Rotation procedure (not built yet) | Add the new master as version 2 beside version 1 in the task environment; match under every configured version and register new identifiers under the newest; retire a version only after its identifiers have been re-entered. Until then, treat the master as a long-lived secret |
| What if it is lost? | Every identifier stops matching. Nothing else breaks: a verifier uses the weaker `person-confirmed` method until the identifiers are entered again under a new master |
| What if it leaks together with the table? | Treat as an incident for the organizations in that table: replace the master and have clinics re-enter identifiers. Matching has so far confirmed nothing about a person beyond what the clinic already holds |

## What an operator can and cannot do

- Nothing here is an operator command: identifiers are registered and withdrawn by clinicians in the application, and link decisions by clinicians and reviewers.
- A withdrawn identifier stays as history and frees its number. A number entered on the wrong patient is withdrawn there and registered on the right one.
- An organization **administrator** (`admin` only) can do none of this: administration is not clinical access ([auth.md](../auth.md#roles)).
- A decision can be seen but never changed: it is a ledger record. A mistaken verification is answered by a later `rejected` decision, which blocks evaluation of that file.
