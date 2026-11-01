# Cookie/storage consent for actual app preferences

Date: 2026-11-01. Public Telesphoros. The original implementation began at `45ce0af1`; delivery rebased the independent consent commit onto main `7ff49849`, including readiness PR #237 and demographics-completeness PR #239. Founder approved necessary storage always on and optional preference persistence off until accepted. The twenty-item UX changes in PR #238 remain separate.

## Scope

| Storage | Behavior |
| --- | --- |
| `telesphoros.theme` | Optional; choice works in memory before permission, persists only after acceptance. |
| `telesphoros.sidebar` | Optional; same gate for collapsed/expanded preference. |
| `telesphoros.landing.language` | Optional; language remains usable in the current tab without persistence. |
| `telesphoros.storage-consent.v1` | Required local record of `{version: 1, preferences: boolean}`. No tracking identifier. Invalid JSON, wrong versions or wrong field types do not enable optional storage. |
| Auth/PKCE and upload-recovery session storage | Existing behavior retained. Never passed through the optional preference store or removed on withdrawal. |
| Identity-provider session and first-party record events | Outside this control. No provider/backend/event contract change. |

No advertising or third-party analytics integration was found in frontend source; those categories are not invented. The UI describes saved preferences rather than promising to control every provider cookie or application event. No legal/compliance certification is claimed.

## Components and usage

`StorageConsentProvider` mounts once in `AppLayout` and owns the initial non-modal bar, the explicit preferences dialog and localized copy. It accepts `children`. `useStorageConsent` exposes the immutable choice snapshot and `openPreferences`. `StoragePreferencesButton({className?})` reopens settings from the footer or Settings page. The existing `ContextDrawer` gains an optional `className` for the scoped safe-area dialog style; its native modal, Escape and focus-return behavior remains shared.

```tsx
<StorageConsentProvider>
  <AppFrame />
</StorageConsentProvider>
// Within that provider:
<StoragePreferencesButton />
```

`PreferenceStorage` provides `read`, `write`, `choose`, `getSnapshot` and `subscribe` for the three typed optional keys. React uses its stable snapshots with the project's existing external-store pattern. The storage accessor can be fault-injected for blocked-storage tests. Acceptance flushes current-tab choices; withdrawal clears only optional keys and keeps current-tab values usable. A failed withdrawal save tries to invalidate the previous grant. If the browser prevents deletion, the panel reports that fact and points to browser site-data controls. A temporary decision is not presented as saved.

Theme, sidebar and language helpers use this store for their persistence only. Existing tests of remembered choices explicitly model a consented visitor, preserving their persistence and visual assertions. Browser sign-in helpers make an explicit UI choice unless a test requests an unanswered or necessary-only flow; dedicated cases prove sign-in works without enabling preferences.

## Design and accessibility

The initial bar has equal outline treatment for acceptance and rejection. On narrow screens, labels may wrap within separate grid cells and Manage occupies another row. A measured layout reserve prevents covering controls; the chat composer stays in document flow while the bar is visible to avoid overlapping its heading. The panel uses the app's quiet opaque surface, Inter UI headings, shared 44px controls, native dialog semantics and device inset spacing. No new animation or dependency was added. Reduced-motion, light/dark and Spanish landing behavior have browser coverage.

Delivery verification reproduced a reduced-motion transition of the body's measured banner padding on both mobile and desktop. The global short-duration fallback had activated an otherwise absent transition. Consent spacing now disables that body transition under reduced motion; the existing landing assertion requiring zero animations is retained unchanged.

The attached [UI Arc consent reference](https://uiarc.dev/components/cookie-consent) supplied the interaction concept. Its source was not installed/copied, and its blur/morph dependency was not adopted.

## How to review

1. On a fresh visit, use necessary-only or Manage. Optional preferences start off.
2. In Settings, change appearance after declining: it works for the tab but is not saved to local storage.
3. Allow preferences, choose Dark, reopen Cookie settings, uncheck remembering preferences and save. The saved optional keys are removed; the current tab remains usable.
4. Reopen from the public footer or Settings. Escape closes without saving a changed draft and returns focus.
5. Use the Spanish landing toggle before granting storage: both the page and consent controls translate, while no language preference is persisted.
6. Block local storage and make a choice. The app explains temporary persistence/clearing limits and still permits necessary functionality.

## Verification evidence and limits

The original preference-read regression failed before the gate. Store/UI tests cover default denial, acceptance, withdrawal, unrelated/required storage preservation, invalid records, cross-tab withdrawal, blocked storage and quota failure. Browser tests cover real sign-in with necessary-only or unanswered consent, session-only appearance, saved-choice withdrawal, keyboard cancellation, reduced motion, Spanish copy, blocked storage and action/heading layout. Visual inspection found and repaired mobile label crowding and a sticky-composer overlap; native browser testing found and repaired focus restoration before dialog closure.

Original implementation logs and producer exit statuses are preserved under `/private/tmp/consent-*` and `/private/tmp/ux-consent-*`. Delivery reruns the project and browser checks on the rebased candidate; current delivery results and the tested commit are recorded separately in the pull request and shared working notes. Historical logs are not evidence of the later candidate. Screenshots contain synthetic fixtures only. PostgreSQL/S3 service tiers, absent reader engine, FHIR IG, container image, real mobile hardware and identity-provider cookie-policy changes are outside these local UI checks. AI assistance: Codex produced code/tests; synthetic mobile/desktop screenshots were inspected. Publication is authorized separately from deployment; this change does not deploy the app.
