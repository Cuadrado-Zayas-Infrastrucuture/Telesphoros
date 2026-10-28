# Feature Specification: Settings page (SET)

**Feature Branch**: `feat/settings-page` (the frontend half; the backend half, `GET /me/profile`, merged as #117)

**Created**: 2026-10-28

**Status**: Approved 2026-10-28. The founder asked for the missing Settings panel. They chose Settings before dark mode and usage, and kept billing deferred. They approved `GET /me/profile` for the organization, the email from the ID token, and no display name in v1. Then, shown that the auth client deliberately discarded everything but the access token, they chose to keep the ID token's `email` claim ("Keep the claim").

**Input**: The app had no Settings page. A signed-in person could not see which account or organization they were in, what their roles allowed, or how their session was held.

## The problem

- A person with several organizations, or several sign-in accounts, cannot tell which one this tab is using.
- Roles decide what the app shows and what the API allows, but nothing says what each role means.
- A member with no role sees almost nothing, and nothing explains why.

## Decisions

- **D1, email:** the auth client keeps the `email` claim of the ID token that `oidc-client-ts` has just validated, and nothing else from it. The ID token and refresh token are still discarded. The email is held in memory (React state) only: never in browser storage, never sent to the API, never logged. It is cleared with everything else at sign-out, session end and failed sign-in.
- **D2, organization:** it comes from `GET /api/v1/me/profile`. An older backend answers 404, and the page then says "Not available on this server yet". That is not an error.
- **D3, who may open it:** any signed-in member, including one with no role. Nothing on it is clinical. The backend allows the same for `/me/profile`.
- **D4, roles:** each role the person holds is shown with what it allows. The text describes the API's `@Roles` declarations and grants nothing.
- **D5, no Appearance section** until dark mode exists. No display name in v1.

## Out of scope

- Dark mode, usage and billing.
- Changing roles or inviting members. That is administration, a later screen.
- Any backend change.

## User Scenarios & Testing

1. **A clinician opens Settings (P1).** They see their email, their organization, and their roles with what each allows. **Acceptance:** the three values appear; no request carries the email.
2. **A member with no role opens Settings (P1).** **Acceptance:** the page opens and explains that they have no role yet and whom to ask.
3. **An older backend (P2).** **Acceptance:** a 404 from `/me/profile` shows "Not available on this server yet", with no alert. A 500 shows an alert and a Retry that works. A reply that breaks the contract is refused.
4. **Signing out (P2).** **Acceptance:** the Sign out button ends the session the same way the header button does, and the email is gone afterwards.
5. **Signed out (P1).** **Acceptance:** `/settings` sends the visitor to sign in and returns them afterwards. Nothing is shown before then.

## Requirements

- **SET-1** `/settings` is inside `ProtectedRoute` and outside every `RequireRole`.
- **SET-2** The session keeps `email` only when the claim is a non-empty string.
- **SET-3** The email never appears in a request address, header or body, or in browser storage.
- **SET-4** Settings is linked from the workspace sidebar and the site header when signed in.
- **SET-5** Brand rules hold: shared tokens and components only, status as words, controls at least 44 px high.
