# Arc UI adaptations

Source: https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/tooltip/tooltip.tsx and `tooltip.module.css` beside it
MIT © 2026 Elia Kuratli. License retained beside this component. Read from the repository on 2026-11-18; the registry entry (`https://uiarc.dev/r/tooltip.json`) and the `shadcn` installer were not used.

`Tooltip` (specs/042) keeps upstream's shape: its own provider, a trigger that keeps the child's element, a portalled label, a 250 ms delay before the first showing, an 8 px gap, a 15rem width, and a fade that starts from `@starting-style`. Like upstream it is built on `@radix-ui/react-tooltip`. Changes from upstream:

- No `motion`: the text morph for a label that changes while open is gone. A label here is a fixed name.
- No shared skip window between tooltips, so each one waits its own delay.
- No CSS module and none of Arc's token file (`foundation.css`). The styles are `src/styles/tooltip.css` on this app's tokens: the page's text and background colours swapped, `--radius-2`, `--elevation-panel`.
- It leaves at once instead of fading out.
- The prop is `label: string`, not `content: ReactNode`: a tooltip here only repeats a control's name (specs/042 D3).

## Arc UI parts deliberately not adopted (2026-11-18)

Checked for specs/042 against Arc UI's free set. Each one below was left out for a reason, not overlooked:

| Item | Why not |
| --- | --- |
| `popover` | Its only use here would be the "About…" info buttons, whose text opens on the page by a decision (specs/041 D7). |
| `hover-card` | Content that needs hover is out of reach on touch. Native disclosure is the pattern here. |
| `cookie-consent` | `components/privacy/StorageConsentProvider` already does this, with tests. |
| `chat-thread` | `components/prompt-kit` already does this. |
| `usage-meter` | It shows use against a plan limit, and no plan limit was found in the product. Its status badge is against the branding rules (status is a word). |
| `activity-heatmap` | `components/usage/UsageCalendar` already does this. |
| `rating`, `time-picker` | No place for either was found. |
| charts, `date-range-picker`, `resizable-panels` | Possible later, each with its own spec. |
