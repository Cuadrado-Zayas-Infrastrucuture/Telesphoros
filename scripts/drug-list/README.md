# Medication drug-list generator

Run `node scripts/drug-list/build.mjs` from a checkout with Node 22.23.4. No package installation is needed. The script also uses the system `curl` when an HTTPS proxy is configured, because Node 22 fetch does not use that proxy automatically. Keep the runtime's proxy and CA configuration; never disable TLS verification.

It retrieves the CPIC API drug table and current CPIC release metadata and verifies each numeric RxCUI at RxNav as IN or MIN. It then adds every IN and MIN concept in RxNorm Current Prescribable Content (NLM provides that subset without licensing restrictions), and refuses the build if the two RxNav sources disagree on a name or type. Brand names (BN) from the same subset become search aliases: one RxNav related-concept request per brand. A brand points to its combination concept (MIN) when there is one, else to its single ingredient; a brand with several ingredients and no combination concept is left out and counted in the output line, never guessed. Every RxNav request shares one schedule, about 8 per second with at most two in flight, well under RxNav's published 20 per second (a run that paced only the brand phase got HTTP 429 on 2026-11-14). A 429 or 503 pauses every lane (Retry-After, else 5, 10, 20, 40, 60 s) and slows the schedule; the sixth throttled answer refuses the artifact. Any other failure is retried twice. Expect ten minutes or more; progress prints every 500 brands, and an error names the phase that stopped. The script writes `packages/shared-types/src/drug-list/bundled.json` atomically only after all requests succeed and the source releases remain unchanged. The metadata distinguishes an API snapshot from a pinned database export. The JSON retains canonical source properties, brand evidence (each brand with the ingredient codes it points to), normalized names, FDA display forms, releases, citations, NLM attribution and a notice about currency. An exclusive `.build.lock` prevents simultaneous builds; ordinary failures remove the lock and leave the prior artifact intact.

The generator is build-time tooling. It receives no patient data. The application never sends a clinician's medication search to these services. FDA-only Tall Man names are independently cited in `fda-tall-man.json`; ISMP-only names wait for written permission.

Operational ownership, monthly review cadence, update acceptance and historical-record compatibility are in [Medication list maintenance](../../docs/ops/medication-list-maintenance.md).

Review the generated diff without manually correcting rows. Run `node --test scripts/drug-list/build.test.mjs`, the shared-types tests, and the medication API/database checks. Record the generated list version in the verification note. Deployment and pushing remain separate decisions.

The standalone archive supplied with the handoff contains this directory and the two public JSON files it needs. If saved as `~/Downloads/telesphoros-drug-list.zip`, this command extracts it without overwriting existing files and runs the generator:

```bash
unzip -n "$HOME/Downloads/telesphoros-drug-list.zip" -d "$HOME/Downloads" && node "$HOME/Downloads/telesphoros-drug-list/scripts/drug-list/build.mjs"
```

Return `~/Downloads/telesphoros-drug-list/packages/shared-types/src/drug-list/bundled.json`. A failure is not an artifact: do not replace the pending manifest by hand.
