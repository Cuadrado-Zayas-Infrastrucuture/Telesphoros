import React, { useEffect, useState } from "react";
import type { Evidence } from "../src/types.js";
import "./style.css";

const labels: Record<string, string> = {
  synthetic_context_ready: "Synthetic context verified",
  consent_required: "Genomic consent required",
  genotype_not_interpretable: "Genomic result unavailable for interpretation",
  pgx_unavailable: "No genomic profile available",
  medications_unavailable: "No active medication context available",
  medications_incomplete: "Medication context needs reconciliation",
};

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
  const [data, setData] = useState<Evidence | null>(null);
  const [error, setError] = useState(
    sessionToken
      ? null
      : "Launch this view from the synthetic EHR patient chart.",
  );
  useEffect(() => {
    if (!sessionToken) return undefined;
    const controller = new AbortController();
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => controller.abort(), 120000);
    fetch("/auth/fhir/pilot/evidence", {
      headers: { Authorization: `Bearer ${sessionToken}` },
      cache: "no-store",
      credentials: "omit",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("unavailable");
        const result: Evidence = await response.json();
        const remaining = Date.parse(result.expiresAt) - Date.now();
        if (
          !result.synthetic ||
          result.clinicalRecommendationsEnabled !== false ||
          !labels[result.status] ||
          !Number.isFinite(remaining) ||
          remaining <= 0
        )
          throw new Error("invalid");
        if (controller.signal.aborted) return;
        setData(result);
        expiryTimer = setTimeout(() => {
          setData(null);
          setError("Session expired. Launch again from the patient chart.");
        }, remaining);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(
            "Context could not be verified. No risk assessment is available. Launch again from the patient chart.",
          );
      })
      .finally(() => clearTimeout(timeout));
    const abortMessage = () =>
      setError(
        "Context retrieval timed out. Launch again from the patient chart.",
      );
    controller.signal.addEventListener("abort", abortMessage);
    return () => {
      controller.signal.removeEventListener("abort", abortMessage);
      controller.abort();
      clearTimeout(timeout);
      clearTimeout(expiryTimer);
    };
  }, [sessionToken]);
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
              {data.evidenceSource === "stored-synthetic" && <p>Stored synthetic evaluation. Source PDF retrieval is not connected.</p>}
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
                <p>No consented, interpretable fixture is available.</p>
              )}
              <p>{data.evidence}</p>
            </section>
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
