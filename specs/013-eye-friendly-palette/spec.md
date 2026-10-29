# Feature Specification: Eye-friendly palette (EYE)

**Feature Branch**: `feat/eye-friendly-palette`

**Created**: 2026-10-28

**Status**: Approved 2026-10-28. The founder said the colours were hard on the eyes. They rejected two rounds of drafts as generic, asked for Christopher Alexander's principles to be applied, and asked for white in light mode and a darker grey or teal in dark mode. They chose graphite for dark from two rendered options, then approved the build plan ("ok"). This replaces the approved light palette (AGENTS.md: a rebrand needs founder approval, a reviewed policy update and new visual and contrast evidence).

## What was wrong

| | Before, light | Before, dark |
| --- | --- | --- |
| Body text | 7.65:1, saturated teal | 14.3:1 on near-black, which glares |
| Cards against the page | `Card` painted `bg-background`, the page's own colour: no separation | the same |

## Decisions (Alexander, *The Nature of Order* Book 4)

- **D1, intensity follows size:** large areas are near-neutral and pale (light) or graphite (dark). Strong colour is kept to small areas: buttons, links, the focus ring, status words.
- **D2, strong centres:** cards (`--panel`) are one step lighter than the page: white on `#F5F7F7`, `#222628` on `#1B1E20`. `Card` now uses `bg-panel`.
- **D3, boundaries:** the header, the workspace sidebar and the footer sit on a new `--band` token, one step darker than the page. The public landing page keeps its own header and footer colours.
- **D4, contrast without glare:** body text about 11 to 13:1 in light and 10.7 to 11.8:1 in dark. Muted text, buttons, borders and status words keep at least 6.0, 6.7, 3.5 and 5.2:1.
- **D5, alternating repetition:** every second `SettingsRow` sits on the page tone (Settings, Usage).
- **D6, unchanged:** logos and their dark-mode plate, type, spacing, sizes, behaviour, and the landing page's layout. Its colours follow the shared tokens, so they shift slightly; the before and after screenshots show by how much.

## Values

| Token | Light | Dark |
| --- | --- | --- |
| `background` | `#F5F7F7` | `#1B1E20` |
| `panel` | `#FFFFFF` | `#222628` |
| `surface` | `#ECF0F0` | `#292E31` |
| `muted` | `#E2EDEB` | `#24302F` |
| `foreground` | `#2C3438` | `#D4D9DB` |
| `muted-foreground` | `#56626A` | `#9CA4A8` |
| `dashboard-foreground` | `#263034` | `#DCE1E3` |
| `dashboard-muted-foreground` | `#4E5A61` | `#A8B0B4` |
| `border` | `#7F8B91` | `#737C81` |
| `divider` | `#DDE3E4` | `#30363A` |
| `primary` | `#1F5A64` | `#74A9AB` |
| `primary-hover` | `#174751` | `#86B9BB` |
| `primary-foreground` | `#FFFFFF` | `#141618` |
| `ring` | `#1F5A64` | `#8FC2C4` |
| `destructive` | `#AE3A2E` | `#E79C91` |
| `destructive-foreground` | `#FFFFFF` | `#141618` |
| `destructive-surface` | `#FBEAE7` | `#3B2526` |
| `success` | `#2A6B42` | `#8CC6A0` |
| `success-surface` | `#E6F2EA` | `#1C2E23` |
| `warning` | `#8A5A12` | `#DDB672` |
| `warning-surface` | `#F8EFDC` | `#352C1C` |
| `brand-accent` | `#2F7685` | `#6FAFBD` |
| `band` | `#EDF1F1` | `#151719` |

## Requirements

- **EYE-1** `check:brand` pins every value above and runs all 24 contrast pairs in both themes (3 new: text, muted text and teal on `--band`).
- **EYE-2** No WCAG A/AA violations in either theme on Settings, Upload, Reports and Usage.
