# Correcting and stopping historical medication ingredients

Date: 2026-11-01

A current medication entry whose ingredient is absent from the latest bundled list can retain its recorded identity while a clinician appends a correction or stop. The API derives the name and source-list version from that same patient entry; it does not accept a client name, remap a code or admit retired ingredients as new entries. The form shows the recorded ingredient read-only. Current-list acknowledgement, optimistic version checks, tenant/role checks, retry fingerprints and ledger verification still apply.

See [verification](../verification/historical-medications.md). This capture-only compatibility path relates to upkeep issue #246; it does not change the drug list, enable clinical flags, grant redistribution rights or authorize deployment.
