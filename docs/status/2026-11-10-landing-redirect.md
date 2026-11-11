# The deployed app no longer shows its own landing page

Date: 2026-11-10

`telesphoros.app` (the `telesphoros-site` project) and the app's own signed-out home page were two separate pages with different headlines and sections. On a host under `telesphoros.app`, the app no longer shows its own landing:

| App host | Signed-out visit to `/` | Signed-in visit to `/` |
| --- | --- | --- |
| `app.staging.telesphoros.app` | The app's own `/signin` | That person's home in the app (`signedInHome`) |
| Any other host under `telesphoros.app` | `https://telesphoros.app/` | The same |

Every build reaches staging first (founder decision, 2026-11-10), so staging never depends on the live site. The landing site has its own staging address, `landing.staging.telesphoros.app`, built from its `staging` branch. It is behind Vercel's login, which invited testers cannot pass, so the staging app sends them to sign in instead.

The sign-in, callback and signed-out pages are unchanged. Local work, the browser tests and the Vercel design preview are served from other hosts and keep the in-app home page. The in-app landing code stays until the redirect has proven itself, then a separate change removes it.
