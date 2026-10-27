# Feature: the reports page in the published build

Date: 2026-10-27

From the 2026-10-27 MVP architecture review. `/reports` was registered only when the frontend was built with `VITE_LOCAL_STORAGE_INTAKE=true`, which `scripts/staging/publish-frontend.sh` refuses, so a published build gave clinicians no way to list or open reports, although `GET /api/v1/reports` already served them. The page came from the owned-storage slice (d365c78) as an opt-in screen; nothing made the flag an access boundary, since the API authorizes every read.

Changed: the route is registered in every build behind the existing clinical-role guard, and the header and workspace navigation link it for a signed-in role. File download stays owned-mode only: signed links need explicitly configured storage origins, which only that build has, so the published page says that downloads are not available in this build and never asks for a file link. An invalid owned-storage setting still fails at start-up. The owned-storage page and its upload links are unchanged.

Proved with tests that fail on the old code: frontend units for the published build (list and details from the API, no download and no link request for clinician and reviewer, reader metadata-only, administrator refused, Reports linked from both navigations, each link's removal caught) and a browser test on the published-style build (a clinician uploads, follows Reports from the navigation, finds the report without a download; an administrator is refused). Not changed: the backend, the publish script's refusals, the upload flow. The owned-storage browser suite (`e2e:storage`) needs a provisioned database and was not run.
