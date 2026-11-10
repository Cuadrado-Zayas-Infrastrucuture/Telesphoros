# Dependabot ignores Node majors
Date: 2026-11-10

Dependabot proposes Node 22 releases for the API image again, and ignores new majors. It had proposed Node 26 as a plain bump; moving to a new major is a planned migration of every pin, not a bump, so the founder chose to stay on 22 (2026-11-10). The guard now requires exactly a majors-only ignore for the Node base image.

Configuration only; nothing is deployed.
