# Docs: SECURITY.md written for the public release (local)

Date: 2026-10-23

The old `SECURITY.md` (five lines) said GitHub private vulnerability reporting "is not yet enabled", which would have been false on the day the repository goes public, and led with the email. The pre-publication security review of the filtered export flagged it.

Now: GitHub private vulnerability reporting is the one route for security problems; no email address is published (the founder chose, on 2026-10-23, to flip without the address until a test message from an outside account arrives at the security mailbox). `SUPPORT.md` and `CODE_OF_CONDUCT.md` no longer name the address either; conduct concerns use the same private channel with a title starting "Conduct:", a stand-in until the mailbox is proven. The rest of the file: no patient data in a report; one maintainer, best effort, an aim to acknowledge in seven days (no service-level commitment, matching `SUPPORT.md`); coordinated disclosure (until a fix, or 90 days); scope (this code, run on the reporter's own machine; no hosted system exists); supported versions (`main` only, pre-1.0). The engineering commitments the old file listed (no PHI or secrets committed, encryption, audit, synthetic training data) are kept at the end.

Dependencies on things outside these files, all on the flip-day list: private vulnerability reporting must be enabled and confirmed (it cannot be on a private repository, so the files are correct only once the repository is public). When the mailbox passes its outside test, the address is added back to the three files in one small change. The seven-day aim and the 90-day window are the founder's to confirm. Not changed: the issue-form config (it already links to `SECURITY.md`), CODEOWNERS.

Local only until the pull request is opened.
