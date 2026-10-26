# Architecture report

Use a single self-contained HTML file with inline CSS and native SVG or HTML diagrams. Keep source text as text: escape `&`, `<`, `>`, double quotes and single quotes before insertion. Do not insert raw source HTML, execute source-supplied code, or turn supplied paths/URLs into active links. A literal `<img onerror=...>` in an inspected file must remain visible text.

## Artifact contract

- Record the repository, exact revision, dirty-state description, date, inspected paths/history and omitted areas.
- For each candidate, show source files/lines, evidence of current friction, a conceptual direction, concrete trade-off, preserved invariants/tests and unresolved evidence. Add an explicit ADR-conflict note only when relevant.
- Show **Observed** and **Proposed concept** side by side on wide screens and stacked on narrow screens. Labels and captions must make the relationship understandable without color. Avoid invented size, latency, coverage or savings scales.
- Use recommendation words such as Strong, Worth exploring or Speculative as plain text, optionally in color. Keep the report quiet: no badges, pills, emoji icons, decorative animation or numerical confidence invented from inspection.
- Include a top recommendation with its evidence and trade-off, or an explicit no-candidate result. Inspection is not proof that a change is safe, deployed or clinically accepted.

No Tailwind/CDN scripts or loose Mermaid security mode are needed. Prefer static diagrams for this small artifact. If a graph genuinely needs a renderer, use an already available tool with strict text handling and include the rendered SVG; do not add a runtime CDN dependency to the saved report.

## Save and review

Resolve the OS temporary directory using the host language's temporary-directory API. Choose a fresh `architecture-review-<timestamp>-<unique>.html` path and create it exclusively; an existing report is preserved. Keep secrets, PHI, report bytes and real infrastructure values out of the artifact. Paths and permitted evidence references can be plain text.

Use the environment's supported HTML preview/render tools when available, then provide the absolute artifact path. Otherwise provide the file for the user to open. Do not launch an OS browser, publish externally, install a renderer or change production as a side effect. Save report/preview evidence locally under the existing evidence rules.

## Minimal static scaffold

Replace the text tokens with escaped, permitted report text. Candidate diagrams need source-specific labels; the boxes below are a conceptual layout, not a prescribed application architecture. Repeat the article only for supported candidates; for an empty scan replace it with the no-candidate statement and scope limits. Never accept an untrusted HTML/SVG fragment as a replacement token.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{{TITLE}}</title>
  <style>
    :root { color-scheme: light dark; }
    body { margin: 0; font-family: var(--font-sans, system-ui, sans-serif); color: var(--foreground, CanvasText); line-height: 1.5; }
    main { max-width: 64rem; margin: auto; }
    h1 { font-size: 1.4rem; } h2 { font-size: 1.15rem; } h3 { font-size: 1rem; }
    article { margin-block: 2rem; }
    .views { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
    figure { margin: 0; padding: 1rem; border: 1px solid var(--border, GrayText); border-radius: var(--radius, .4rem); }
    figcaption { margin-bottom: 1rem; font-weight: 600; }
    .module { padding: .65rem; margin-block: .5rem; border: 1px solid var(--border, GrayText); overflow-wrap: anywhere; }
    .deep { border-width: 2px; }
    .muted { color: var(--muted-foreground, GrayText); }
    code { font-family: var(--font-mono, monospace); overflow-wrap: anywhere; }
    @media (max-width: 640px) { .views { grid-template-columns: 1fr; } }
  </style>
</head>
<body><main>
  <header><h1>{{TITLE}}</h1><p class="muted">{{SCOPE}}</p></header>
  <article id="candidate-1">
    <h2>{{CANDIDATE}}</h2>
    <p>{{STRENGTH}}</p><p><code>{{FILES}}</code></p>
    <p>{{EVIDENCE}}</p>
    <div class="views">
      <figure><figcaption>Observed</figcaption>
        <div class="module">{{CALLER}}</div>
        <div class="module">{{COORDINATION}}</div>
      </figure>
      <figure><figcaption>Proposed concept</figcaption>
        <div class="module">{{CALLER}}</div>
        <div class="module deep">{{OWNER}}</div>
      </figure>
    </div>
    <h3>Trade-off and evidence to retain</h3><p>{{TRADEOFF}}</p>
    <p>{{LIMITS}}</p>
  </article>
  <section><h2>Top recommendation</h2><p>{{RECOMMENDATION}}</p></section>
</main></body></html>
```

Validate the filled artifact at desktop and narrow widths: no unexpected requests, script/event-handler elements or active source links; source strings display literally; both views and the revision/scope remain readable. This checks the artifact produced, not every future invocation of the skill.
