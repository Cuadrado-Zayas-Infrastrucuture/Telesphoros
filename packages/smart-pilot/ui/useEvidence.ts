import { useEffect, useRef, useState } from "react";
import type { Evidence } from "../src/types.js";

export const labels: Record<string, string> = {
  synthetic_context_ready: "Synthetic context verified",
  consent_required: "Genomic consent required",
  genotype_not_interpretable: "Genomic result unavailable for interpretation",
  pgx_unavailable: "No genomic profile available",
  evaluation_withheld: "Selected evaluation evidence is withheld",
  medications_unavailable: "No active medication context available",
  medications_incomplete: "Medication context needs reconciliation",
};
const expired = "Session expired. Launch again from the patient chart.";

export function useEvidence(sessionToken: string | null) {
  const [data, setData] = useState<Evidence | null>(null);
  const [error, setError] = useState<string | null>(sessionToken ? null : "Launch this view from the synthetic EHR patient chart.");
  const [checking, setChecking] = useState(false);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    if (!sessionToken) return;
    let stopped = false, generation = 0, pending = false;
    let sessionDeadline = Infinity;
    let controller: AbortController | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const later = (fn: () => void, ms: number) => {
      const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
      timers.add(timer);
    };
    const clear = () => {
      generation++; controller?.abort(); pending = false;
      for (const timer of timers) clearTimeout(timer);
      timers.clear(); setData(null); setChecking(false);
    };
    const invalidate = (message: string) => { clear(); setError(message); };
    const run = async () => {
      if (stopped || pending) return;
      if (Date.now() >= sessionDeadline) { invalidate(expired); return; }
      if (document.hidden || navigator.onLine === false) {
        invalidate("View paused. Evidence will be rechecked when this page is visible and online."); return;
      }
      clear(); setError(null); setChecking(true); pending = true;
      const current = generation;
      const request = new AbortController(); controller = request;
      later(() => invalidate(Date.now() >= sessionDeadline ? expired : "Evidence check timed out. Recheck before viewing results."),
        Math.min(120000, sessionDeadline - Date.now()));
      try {
        const response = await fetch("/auth/fhir/pilot/evidence", {
          headers: { Authorization: `Bearer ${sessionToken}` }, cache: "no-store", credentials: "omit", signal: request.signal,
        });
        if (!response.ok) throw new Error("unavailable");
        const result: Evidence = await response.json();
        if (stopped || generation !== current || request.signal.aborted) return;
        const expiry = Date.parse(result.expiresAt), freshness = Date.parse(result.freshUntil);
        if (!result.synthetic || result.clinicalRecommendationsEnabled !== false || !labels[result.status] ||
            !Number.isFinite(expiry) || !Number.isFinite(freshness) || expiry <= Date.now() || freshness <= Date.now() ||
            freshness > expiry || freshness > Date.now() + 30000) throw new Error("invalid");
        sessionDeadline = Math.min(sessionDeadline, expiry);
        if (Date.now() >= sessionDeadline) throw new Error("expired");
        for (const timer of timers) clearTimeout(timer);
        timers.clear(); pending = false; setChecking(false); setData(result);
        later(() => invalidate(expired), sessionDeadline - Date.now());
        later(() => invalidate("Evidence freshness expired. Recheck before viewing results."), freshness - Date.now());
        later(() => { void run(); }, Math.min(15000, freshness - Date.now()));
      } catch {
        if (!stopped && generation === current && !request.signal.aborted)
          invalidate("Context could not be verified. No risk assessment is available. Recheck or launch again from the patient chart.");
      }
    };
    const pauseOrResume = () => {
      if (document.hidden || navigator.onLine === false)
        invalidate("View paused. Evidence will be rechecked when this page is visible and online.");
      else void run();
    };
    refresh.current = () => { void run(); };
    document.addEventListener("visibilitychange", pauseOrResume);
    window.addEventListener("focus", pauseOrResume);
    window.addEventListener("offline", pauseOrResume);
    window.addEventListener("online", pauseOrResume);
    void run();
    return () => {
      stopped = true; generation++; controller?.abort();
      for (const timer of timers) clearTimeout(timer);
      document.removeEventListener("visibilitychange", pauseOrResume);
      window.removeEventListener("focus", pauseOrResume);
      window.removeEventListener("offline", pauseOrResume);
      window.removeEventListener("online", pauseOrResume);
      refresh.current = () => {};
    };
  }, [sessionToken]);
  return { data, error, checking, recheck: () => refresh.current() };
}
