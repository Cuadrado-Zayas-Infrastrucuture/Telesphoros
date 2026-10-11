// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import SmartEvidencePage from "../ui/SmartEvidencePage.js";

const payload = (history = false) => ({
  synthetic: true, clinicalRecommendationsEnabled: false, status: history ? "evaluation_withheld" : "synthetic_context_ready",
  patient: "synthetic-a", encounter: null, clinician: "Practitioner/synthetic", tenant: "synthetic",
  expiresAt: new Date(Date.now() + 60000).toISOString(), freshUntil: new Date(Date.now() + 30000).toISOString(),
  medications: [], pagesRead: 1, uncertainMedicationCount: 0, unmappedMedicationCount: 0,
  profile: history ? [] : [{ gene: "CYP2C19", result: "Synthetic current phenotype" }], evidenceSource: "stored-synthetic",
  pgxFhirPreview: history ? null : { resourceType: "Bundle", entry: [{ resource: { resourceType: "DocumentReference",
    content: [{ attachment: { contentType: "application/pdf", data: btoa("%PDF-1.4 SYNTHETIC") } }] } }] },
  correctionHistory: history ? { evaluationId: "synthetic-selected", state: "retracted", current: false,
    events: [{ id: "synthetic-correction", kind: "retraction", reasonCode: "input-misread", createdAt: "2026-10-11T00:00:00Z" }] } : null,
  evidence: "Synthetic only",
});
const response = (history = false) => ({ ok: true, json: async () => payload(history) });
const show = async () => { await act(async () => { render(<SmartEvidencePage sessionToken={"s".repeat(43)} />); }); };
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: vi.fn(() => "blob:synthetic-pdf"), revokeObjectURL: vi.fn() }));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("poll clears evidence and revokes the PDF before showing a retraction history", async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })));
  await show(); expect(screen.getByText(/Synthetic current phenotype/)).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  expect(screen.queryByText(/Synthetic current phenotype/)).not.toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument(); expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:synthetic-pdf");
  await act(async () => { finish(response(true)); });
  expect(screen.getByText(/retraction — input-misread/)).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(2);
});

test("a failed recheck removes prior genomic content and history until a successful explicit retry", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response()).mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(response(true)));
  await show(); await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Recheck evidence" })); });
  expect(screen.queryByText(/Synthetic current phenotype/)).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("No risk assessment");
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Recheck evidence" })); });
  expect(screen.getByRole("heading", { name: "Selected evaluation history" })).toBeInTheDocument();
});

test.each(["hidden", "offline"])("%s state invalidates evidence and rechecks on return", async mode => {
  const state = mode === "hidden" ? vi.spyOn(document, "hidden", "get") : vi.spyOn(navigator, "onLine", "get");
  state.mockReturnValue(mode !== "hidden");
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response())); await show();
  state.mockReturnValue(mode === "hidden");
  await act(async () => { if (mode === "hidden") document.dispatchEvent(new Event("visibilitychange")); else window.dispatchEvent(new Event("offline")); });
  expect(screen.queryByRole("link")).not.toBeInTheDocument(); expect(screen.queryByText(/Synthetic current phenotype/)).not.toBeInTheDocument();
  state.mockReturnValue(mode !== "hidden");
  await act(async () => { if (mode === "hidden") document.dispatchEvent(new Event("visibilitychange")); else window.dispatchEvent(new Event("online")); });
  expect(screen.getByText(/Synthetic current phenotype/)).toBeInTheDocument(); expect(fetch).toHaveBeenCalledTimes(2);
});

test("a late response after the page hides cannot restore evidence even if fetch ignores abort", async () => {
  let finish!: (value: unknown) => void;
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })));
  await show(); await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
  hidden.mockReturnValue(true); await act(async () => { document.dispatchEvent(new Event("visibilitychange")); finish(response()); });
  expect(screen.queryByRole("link")).not.toBeInTheDocument(); expect(screen.queryByText(/Synthetic current phenotype/)).not.toBeInTheDocument();
});

test("expired freshness is rejected and an in-flight request cannot outlive the session", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...payload(), freshUntil: new Date(Date.now() - 1).toISOString() }) }));
  await show(); expect(screen.queryByRole("link")).not.toBeInTheDocument(); cleanup();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response()).mockImplementationOnce(() => new Promise(() => {})));
  await show(); await act(async () => { await vi.advanceTimersByTimeAsync(60001); });
  expect(screen.queryByRole("link")).not.toBeInTheDocument(); expect(screen.getByRole("status")).toHaveTextContent("Session expired");
});

test("an old launch response cannot replace the new chart even if its fetch ignores abort", async () => {
  let finish!: (value: unknown) => void;
  vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(response(true)));
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<SmartEvidencePage sessionToken={"a".repeat(43)} />); });
  await act(async () => { view.rerender(<SmartEvidencePage sessionToken={"b".repeat(43)} />); });
  await act(async () => { finish(response()); });
  expect(screen.getByRole("heading", { name: "Selected evaluation history" })).toBeInTheDocument();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(screen.queryByText(/Synthetic current phenotype/)).not.toBeInTheDocument();
});

test("freshness expires independently of a longer session and focus revalidates", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ ...payload(), freshUntil: new Date(Date.now() + 5000).toISOString() }) }).mockResolvedValueOnce(response(true)));
  await show(); expect(screen.getByRole("link")).toBeInTheDocument();
  await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
  expect(screen.queryByRole("link")).not.toBeInTheDocument(); expect(screen.getByRole("status")).toHaveTextContent("freshness expired");
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(screen.getByRole("heading", { name: "Selected evaluation history" })).toBeInTheDocument();
});
