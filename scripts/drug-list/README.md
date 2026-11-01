# Medication drug-list generator

Run `node scripts/drug-list/build.mjs` from a checkout with Node 22.22.0. No package installation is needed. The script also uses the system `curl` when an HTTPS proxy is configured, because Node 22 fetch does not use that proxy automatically. Keep the runtime's proxy and CA configuration; never disable TLS verification.

It retrieves the CPIC API drug table and current CPIC release metadata, verifies each numeric RxCUI at RxNav as IN or MIN, and writes `packages/shared-types/src/drug-list/bundled.json` atomically only after all requests succeed and the source releases remain unchanged. The metadata distinguishes an API snapshot from a pinned database export. The JSON retains canonical source properties, normalized names, FDA display forms, releases, citations, NLM attribution and a notice about currency. An exclusive `.build.lock` prevents simultaneous builds; ordinary failures remove the lock and leave the prior artifact intact.

The generator is build-time tooling. It receives no patient data. The application never sends a clinician's medication search to these services. FDA-only Tall Man names are independently cited in `fda-tall-man.json`; ISMP-only names wait for written permission.

Review the generated diff without manually correcting rows. Run `node --test scripts/drug-list/build.test.mjs`, the shared-types tests, and the medication API/database checks. Record the generated list version in the verification note. Deployment and pushing remain separate decisions.

The standalone archive supplied with the handoff contains this directory and the two public JSON files it needs. If saved as `~/Downloads/telesphoros-drug-list.zip`, this command extracts it without overwriting existing files and runs the generator:

```bash
unzip -n "$HOME/Downloads/telesphoros-drug-list.zip" -d "$HOME/Downloads" && node "$HOME/Downloads/telesphoros-drug-list/scripts/drug-list/build.mjs"
```

Return `~/Downloads/telesphoros-drug-list/packages/shared-types/src/drug-list/bundled.json`. A failure is not an artifact: do not replace the pending manifest by hand.
