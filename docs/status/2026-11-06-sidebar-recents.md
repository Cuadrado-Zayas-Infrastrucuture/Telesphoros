# The sidebar reads like a chat app, and patients have their own page

Date: 2026-11-06

The signed-in sidebar stacked the brand, New chat, Follow-ups, a Past reports list, an inline patient roster with Add patient, All reports, Usage and Settings, and scrolled on a laptop. Spec 034 (`specs/034-sidebar-recents/`) lays it out the way chat apps do; the founder chose each step from screenshots.

What changed, frontend only:

- Top to bottom: New chat; Patients, Reports, Follow-ups and Usage (each for the roles that had them); one Recents list that takes the remaining height; and the account at the foot.
- Patients moved to their own page, `/patients`: the roster, the find box, the demographics line and, for writer roles, Add patient. It uses the same requests as before.
- Recents is the former Past reports: one line per report, its status as a word in color (including "Upload not finished" from the unfinished-uploads change, with its Remove beside the row), and a row opens that report's details on Reports.
- The account menu holds the name and email, Settings, Language (English only, said plainly: only the public landing is translated), Help (help, feedback and bug reports, as links to the repository's support file and issue forms), Theme, Learn more (changelog, security policy, code of conduct, licence, cookie settings) and Sign out.
- The sidebar still collapses to icons and can now be dragged between 14rem and 24rem (also a keyboard slider), kept as an optional preference behind the existing storage consent.

Verification, Node 22.22.0, on the branch merged with `main`: frontend lint, typecheck, build, chunk, foundation and branding guards; frontend 785 unit tests; the workspace tests; the image guard; the browser suites (`e2e`, local, owned-local) and `e2e:storage` with the medication fence on a disposable PostgreSQL 16; gitleaks.

Not done: there is no privacy policy or terms of service to link from Learn more yet. Help, feedback and bug reports go to public GitHub issue forms written for developers; whether testers should use another channel is the founder's call. The signed-in app has no Spanish copy, so Language offers English only.
