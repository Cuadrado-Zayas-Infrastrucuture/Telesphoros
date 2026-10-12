import type { CorrectionHistory as History } from "../src/correction-history.js";

export function CorrectionHistory({ history }: { history: History }) {
  return <section className="pilot-card" style={{ marginTop: "calc(6 * var(--space-unit))" }}>
    <h2>Selected evaluation history</h2>
    <p>Evaluation {history.evaluationId}</p>
    <p>State: {history.state}. {history.current ? "Current evaluation." : "Not current. Genomic evidence and source PDF are withheld."}</p>
    {history.events.length ? <ol>{history.events.map(event => <li key={event.id}>
      <time dateTime={event.createdAt}>{event.createdAt}</time>: {event.kind} — {event.reasonCode}
    </li>)}</ol> : <p>No corrections recorded for this selected evaluation.</p>}
    <p>History is read-only. Replacement evaluations are not selected automatically. Notes are not loaded.</p>
  </section>;
}
