# Feature Specification: Dark mode (DRK)

**Feature Branch**: `feat/dark-mode`

**Created**: 2026-10-28

**Status**: Approved 2026-10-28. After Settings (#121), the founder asked for dark mode next. A draft palette was shown with every contrast pair, and the founder approved it as drafted ("Approve, build it").

**Input**: The app had only a light theme. People who work with their device set to dark had no matching option.

## Decisions

- **D1, palette:** the dark values in `scripts/branding-policy.json` (`darkTokens`), built from the brand teal and seafoam. Body text is seafoam `#DCEBE7` on near-black teal `#0E1B1F`. Buttons are light teal `#86C7D2` with dark text. Status colours are lightened, and are still words in colour.
- **D2, choice:** Settings offers *Match this device* (the default), *Light* and *Dark*. *Match this device* follows the device's setting live.
- **D3, storage:** only the words `light` or `dark` are kept in `localStorage`, so a reload opens in the chosen theme. Nothing about the person is stored. If storage is blocked, the page follows the device.
- **D4, landing:** the public home page keeps its approved light design whatever the choice.
- **D5, artwork:** the logo files are unchanged. In the dark theme they sit on a seafoam plate, because their dark teal would almost vanish on the dark page.
- **D6, colours only:** the dark theme changes colour tokens and nothing else. Type, spacing and sizes are the same in both themes.

## Out of scope

- A dark landing page or a dark report artwork.
- Saving the choice on the server or across devices.
- Usage and billing.

## User Scenarios & Testing

1. **Choosing dark (P1).** **Acceptance:** choosing *Dark* turns the page dark at once; a reload, after signing in again, opens dark.
2. **Following the device (P1).** **Acceptance:** with *Match this device*, switching the device to dark or light changes the page without a reload.
3. **Readable in dark (P1).** **Acceptance:** Settings, Upload and Reports have no WCAG A/AA violations, colour contrast included, in the dark theme.
4. **Landing (P2).** **Acceptance:** with *Dark* saved, the home page is still light.

## Requirements

- **DRK-1** Every pair in `branding-policy.json` `contrast` passes in both themes; `check:brand` fails the build otherwise.
- **DRK-2** The dark block in `tokens.css` may set only the colours in `darkTokens`, each to its approved value.
- **DRK-3** Light values stay pinned exactly as before.
- **DRK-4** The theme is applied before the first render and before paint on every route change.
- **DRK-5** Controls keep their 44 px targets; the choice is a native radio group with a legend.
