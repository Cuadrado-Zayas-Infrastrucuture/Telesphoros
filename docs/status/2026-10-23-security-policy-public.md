# Docs: SECURITY.md written for the public release (local)

Date: 2026-10-23

The old `SECURITY.md` (five lines) said GitHub private vulnerability reporting "is not yet enabled", which would have been false on the day the repository goes public, and led with the email. The pre-publication security review of the filtered export flagged it.

Now: GitHub private vulnerability reporting is the preferred route and `security@cuadradozayasinfrastructure.com` the fallback (the founder chose to keep the email); no patient data in a report; one maintainer, best effort, an aim to acknowledge in seven days (no service-level commitment, matching `SUPPORT.md`); coordinated disclosure (until a fix, or 90 days); scope (this code, run on the reporter's own machine; no hosted system exists); supported versions (`main` only, pre-1.0). The engineering commitments the old file listed (no PHI or secrets committed, encryption, audit, synthetic training data) are kept at the end.

Dependencies on things outside this file, all on the flip-day list: private vulnerability reporting must be enabled and confirmed (it cannot be on a private repository, so the file is correct only once the repository is public); the security mailbox must receive a message from an outside account before the address is published. The seven-day aim and the 90-day window are the founder's to confirm. Not changed: `SUPPORT.md`, `CODE_OF_CONDUCT.md`, the issue-form config (it already links here), CODEOWNERS.

Local only until the pull request is opened.
