# Bklit UI adaptations

Source: https://github.com/bklit/bklit-ui/blob/e303e47d9d0599be79b328c5f5098ec8605d9e97/packages/ui/src/charts/funnel-chart.tsx
MIT © 2026 uixmat. License retained beside these components. The registry entry (`https://bklit.com/r/funnel-chart.json`) served the same file on 2026-10-27.

`FunnelChart` keeps upstream's curved segment path (`hSegmentPath`) and its ring formula with two layers: a halo at full scale and a core at 0.825. Changes from upstream:

- No `motion` and none of `@bklit/chart-animation`, `@bklit/utils` or `@bklit/chart-utils`: no entrance or hover animation, no patterns, no grid, horizontal only.
- A fixed `viewBox` instead of measuring with `ResizeObserver`; the SVG scales to its box.
- Colours are brand tokens: core `--primary`, halo `--brand-accent` at 0.18 opacity. There is no colour prop, so no stage can pick its own colour.
- A stage is never drawn wider than the one before it. An empty first stage draws flat instead of dividing by zero.
- The SVG is `aria-hidden`. The consumer gives every count as text beside it, as `ReportStages` does.
