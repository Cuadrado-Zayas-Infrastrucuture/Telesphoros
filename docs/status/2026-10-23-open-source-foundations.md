# Community files for the public release (local)

Date: 2026-10-23

Adds the files an open-source project is expected to carry: `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1), issue forms and a template chooser under `.github/ISSUE_TEMPLATE/`, `CONTRIBUTING.md` additions for local setup, `AGENTS.md`, `SUPPORT.md`, `MAINTAINERS.md` and a `CHANGELOG.md` for 0.1.0 (the date is a placeholder until the tag). `SECURITY.md` now names the security mailbox, `security@cuadradozayasinfrastructure.com`, instead of a person's GitHub handle; `SUPPORT.md` and the code of conduct point private reports to the same address. `CODEOWNERS` and `MAINTAINERS.md` keep the GitHub handle, because they name an owner, not a contact.

Not done, and a gate before the repository is made public: the mailbox has not been tested from an outside account. A group that does not accept outside posting silently drops reports. Private vulnerability reporting on GitHub cannot be enabled until the repository is public, and the changelog date is a placeholder. Nothing here changes product code or CI.

Local only until the pull request is opened.
