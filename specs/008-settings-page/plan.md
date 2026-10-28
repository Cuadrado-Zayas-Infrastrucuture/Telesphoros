# Plan: Settings page

One pull request off `main`, frontend only.

| Area                                              | Change                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth/authClient.ts`                              | `Session.email?`: copied from `user.profile.email` when it is a non-empty string, before `removeUser()` drops the ID token. The header comment now states exactly what is kept.                                                                                                                                                                   |
| `auth/AuthProvider.tsx`                           | `email: string \| null` in the context; set with the roles at sign-in, cleared in `clear()`.                                                                                                                                                                                                                                                      |
| `lib/organizationProfile.ts`                      | `loadOrganization()`: 404 means unavailable; any other failure is an `OrganizationLoadError`; the reply is parsed with `meProfileDtoSchema`. It imports `./api` for its type only.                                                                                                                                                                |
| `lib/roleDescriptions.ts`                         | One entry per `Role`, taken from the backend's `@Roles` lists, plus the no-role text.                                                                                                                                                                                                                                                             |
| `pages/SettingsPage.tsx`, `components/settings/*` | Account, Roles, Session and privacy, Environment. One component per file.                                                                                                                                                                                                                                                                         |
| `app/routes.tsx`, `components/layout/*`           | The route; a sidebar and header link; the AccountMenu comment updated.                                                                                                                                                                                                                                                                            |
| `vite.config.ts`                                  | A `router` code-splitting group, next to the existing `ui-utilities` one. The lazy Settings route moved React Router's core from a shared chunk into the entry file: +29 kB gzip there, +45 bytes in what the page loads at start. With the group, the entry is 123.5 kB (main: 122.4 kB) and the start-up load is 169,860 bytes (main: 169,312). |

## Verification

- Unit tests:
  - Only the email claim is kept, and the ID token is still dropped.
  - No email is kept when the claim is missing, empty or not a string.
  - The provider holds the email only while signed in, and never in storage.
  - The page: the ready, 404, error with retry, contract-breaking reply and no-role states; sign-out; the navigation link; the signed-out redirect; the email never sent.
- Deliberate breaks:
  - Without the clear on sign-out, the provider test fails.
  - Sending the email in a header makes the "never sent" test fail.
- Gates: typecheck, lint, build, all frontend tests, `check:chunks`, `check:brand`, `test:brand`.
- Browser: desktop and mobile through the fake IdP, with screenshots.
