import React from "react";
import { useEvidence, labels } from "./useEvidence.js";
import { CorrectionHistory } from "./CorrectionHistory.js";
import "./style.css";
import { SourcePdf } from "./SourcePdf.js";

export function takeSmartSession(
  location: Pick<Location, "hash" | "pathname"> = window.location,
  history: Pick<History, "replaceState"> = window.history,
) {
  const token = new URLSearchParams(location.hash.slice(1)).get(
    "smart_session",
  );
  history.replaceState(null, "", location.pathname);
  return /^[A-Za-z0-9_-]{43}$/.test(token || "") ? token : null;
}

function SessionEvidence({ sessionToken }: { sessionToken: string | null }) {
  const { data, error, checking, recheck } = useEvidence(sessionToken);
  return (
    <main
      style={{
        fontFamily: "var(--font-family-sans)",
        color: "var(--foreground)",
        background: "var(--surface)",
        minHeight: "100vh",
        padding: "calc(6 * var(--space-unit))",
      }}
    >
      <div style={{ maxWidth: "var(--size-page)", margin: "0 auto" }}>
        <h1>Telesphoros PGx review</h1>
        <p style={{ color: "var(--muted-foreground)" }}>
          Synthetic integration pilot · Read-only
        </p>
        <p>
          Clinical recommendations are disabled. This view tests patient context
          and fixture display; it does not establish absence of PGx risk.
        </p>
        <div role="status" aria-live="polite">
          {error ||
            (!data
              ? "Retrieving and verifying patient context…"
              : labels[data.status])}
        </div>
        {sessionToken && <button className="pilot-recheck" type="button" onClick={recheck} disabled={checking}>Recheck evidence</button>}
        {data && (
          <>
            <section
              className="pilot-card"
              style={{ marginTop: "calc(6 * var(--space-unit))" }}
            >
              <h2>Launch context</h2>
              <dl>
                <dt>Patient</dt>
                <dd>{data.patient}</dd>
                <dt>Encounter</dt>
                <dd>{data.encounter || "Not provided"}</dd>
                <dt>Clinician</dt>
                <dd>{data.clinician}</dd>
                <dt>Office</dt>
                <dd>{data.tenant}</dd>
              </dl>
            </section>
            <section
              className="pilot-card"
              style={{ marginTop: "calc(6 * var(--space-unit))" }}
            >
              <h2>Medication context</h2>
              <p>
                {data.pagesRead} FHIR pages read.{" "}
                {data.uncertainMedicationCount} records with uncertain status;{" "}
                {data.unmappedMedicationCount} active records without RxNorm
                coding.
              </p>
              {data.medications.length ? (
                <ul>
                  {data.medications.map((med, index) => (
                    <li key={`${med.requestId}-${index}`}>
                      {med.drug || "Unnamed medication"}
                      {med.rxcui ? ` (${med.rxcui})` : " — uncoded"}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>
                  No active medications available for review. This is not an
                  all-clear result.
                </p>
              )}
            </section>
            <section
              className="pilot-card"
              style={{ marginTop: "calc(6 * var(--space-unit))" }}
            >
              <h2>Synthetic genomic fixture</h2>
              {data.evidenceSource === "stored-synthetic" && <><p>Stored synthetic evaluation.</p><SourcePdf bundle={data.pgxFhirPreview} /></>}
              {data.pgxFhirPreview ? (
                <details>
                  <summary>Versioned FHIR preview (synthetic only)</summary>
                  <p>Core FHIR R4 collection. Source bytes and interpretation identities are pinned. No EHR write or clinical approval.</p>
                  <pre style={{ overflowX: "auto", maxHeight: "28rem" }}>{JSON.stringify(data.pgxFhirPreview, null, 2)}</pre>
                </details>
              ) : <p>Versioned FHIR preview unavailable. No older result is substituted.</p>}
              {data.profile.length ? (
                <ul>
                  {data.profile.map((row, index) => (
                    <li key={index}>
                      {row.gene}: {row.result}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{data.correctionHistory ? "Genomic evidence is withheld for this selected evaluation." : "No consented, interpretable fixture is available."}</p>
              )}
              <p>{data.evidence}</p>
            </section>
            {data.correctionHistory && <CorrectionHistory history={data.correctionHistory} />}
          </>
        )}
        <p style={{ marginTop: "calc(6 * var(--space-unit))" }}>
          Close this tab to return to the EHR. Changing patients requires a new
          launch.
        </p>
      </div>
    </main>
  );
}

// Remount on a new launch so no prior patient's data or error survives a token change.
export default function SmartEvidencePage({
  sessionToken,
}: {
  sessionToken: string | null;
}) {
  return (
    <SessionEvidence
      key={sessionToken || "no-session"}
      sessionToken={sessionToken}
    />
  );
}
