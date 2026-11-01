# Cookie and browser-storage preferences
Date: 2026-11-01

The app now offers equally prominent necessary-only and optional-preference choices, plus a preferences panel. Optional theme, sidebar and landing-language storage is off until accepted. Choices still work for the current tab; withdrawing permission removes only those three optional keys. A versioned decision is remembered when local storage is available. Invalid/obsolete decisions default to no optional persistence, and blocked storage reports a temporary choice or inability to clear saved values.

Cookie settings can be reopened from the public footer and signed-in Settings. The landing's consent copy follows English/Spanish; app pages remain English. The initial bar is non-modal, reserves room around app controls and uses shared tokens and controls without motion/blur or a new library. Preferences use the existing native dialog, with keyboard/focus handling and safe-area spacing.

Auth/PKCE session storage, upload recovery, API contracts and existing first-party result-render reporting are unchanged. No analytics/marketing category or policy link for a nonexistent feature was added. [Architecture and verification](../design/storage-consent.md) describes the exact storage scope and browser evidence.
