// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import SmartEvidencePage, {
  takeSmartSession,
} from "../ui/SmartEvidencePage.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("synthetic SMART evidence", () => {
  it("removes the session fragment before any request and never persists it", () => {
    const replaceState = vi.fn();
    expect(
      takeSmartSession(
        {
          hash: "#smart_session=" + "s".repeat(43),
          pathname: "/smart/evidence",
        },
        { replaceState },
      ),
    ).toHaveLength(43);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/smart/evidence");
  });
  it("requires a fresh chart launch when no session is present", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<SmartEvidencePage sessionToken={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Launch this view");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("renders verified synthetic context with recommendations disabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          synthetic: true,
          clinicalRecommendationsEnabled: false,
          status: "synthetic_context_ready",
          patient: "synthetic-a",
          encounter: null,
          clinician: "Practitioner/synthetic",
          tenant: "synthetic-office",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          pagesRead: 2,
          medications: [],
          uncertainMedicationCount: 0,
          unmappedMedicationCount: 0,
          profile: [],
          evidence: "Synthetic fixture only",
        }),
      }),
    );
    render(<SmartEvidencePage sessionToken={"s".repeat(43)} />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Synthetic context verified",
      ),
    );
    expect(screen.getByText("synthetic-a")).toBeInTheDocument();
    expect(
      screen.getByText(/This is not an all-clear result/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Clinical recommendations are disabled/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
  it("withholds context on API failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    render(<SmartEvidencePage sessionToken={"s".repeat(43)} />);
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "No risk assessment is available",
      ),
    );
    expect(
      screen.queryByRole("heading", { name: "Launch context" }),
    ).not.toBeInTheDocument();
  });
});

const syntheticResponse = () => ({
  ok: true,
  json: async () => ({
    synthetic: true,
    clinicalRecommendationsEnabled: false,
    status: "synthetic_context_ready",
    patient: "synthetic-a",
    encounter: null,
    clinician: "Practitioner/synthetic",
    tenant: "synthetic-office",
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    pagesRead: 1,
    medications: [],
    uncertainMedicationCount: 0,
    unmappedMedicationCount: 0,
    profile: [],
    evidence: "Synthetic fixture only",
  }),
});
it("removes the previous patient when its session is removed", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(syntheticResponse()));
  const view = render(<SmartEvidencePage sessionToken={"a".repeat(43)} />);
  await screen.findByText("synthetic-a");
  view.rerender(<SmartEvidencePage sessionToken={null} />);
  expect(screen.queryByText("synthetic-a")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Launch this view");
});
it("withholds the old patient while a different session is pending or fails", async () => {
  let finish: ((value: { ok: boolean }) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(syntheticResponse())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
  );
  const view = render(<SmartEvidencePage sessionToken={"a".repeat(43)} />);
  await screen.findByText("synthetic-a");
  view.rerender(<SmartEvidencePage sessionToken={"b".repeat(43)} />);
  expect(screen.queryByText("synthetic-a")).not.toBeInTheDocument();
  finish?.({ ok: false });
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("No risk assessment"),
  );
});
it("clears an earlier session error when a fresh session succeeds", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(syntheticResponse()),
  );
  const view = render(<SmartEvidencePage sessionToken={"a".repeat(43)} />);
  await waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent("No risk assessment"),
  );
  view.rerender(<SmartEvidencePage sessionToken={"b".repeat(43)} />);
  await screen.findByText("synthetic-a");
  expect(screen.getByRole("status")).toHaveTextContent(
    "Synthetic context verified",
  );
});

it("shows a read-only versioned preview and removes it when the launch changes", async () => {
  const response = syntheticResponse();
  const data = await response.json();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ...data, pgxFhirPreview: {
      resourceType: "Bundle", type: "collection", entry: [{ resource: {
        resourceType: "DiagnosticReport", identifier: [{ value: "synthetic-evaluation-2" }],
      } }],
    } }),
  }));
  const view = render(<SmartEvidencePage sessionToken={"a".repeat(43)} />);
  await screen.findByText("Versioned FHIR preview (synthetic only)");
  expect(screen.getByText(/"synthetic-evaluation-2"/)).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
  view.rerender(<SmartEvidencePage sessionToken={null} />);
  expect(screen.queryByText(/"synthetic-evaluation-2"/)).not.toBeInTheDocument();
});
it("makes an unavailable version explicit without rendering a source or old result", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(syntheticResponse()));
  render(<SmartEvidencePage sessionToken={"s".repeat(43)} />);
  await screen.findByText("Versioned FHIR preview unavailable. No older result is substituted.");
  expect(screen.queryByText("Versioned FHIR preview (synthetic only)")).not.toBeInTheDocument();
});


it("offers only a local PDF download and revokes it when the chart changes", async () => {
  const create = vi.fn().mockReturnValue("blob:synthetic-pdf");
  const revoke = vi.fn();
  vi.stubGlobal("URL", Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }));
  const base = await syntheticResponse().json();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ...base,
    evidenceSource: "stored-synthetic", pgxFhirPreview: { entry: [{ resource: {
      resourceType: "DocumentReference", content: [{ attachment: { contentType: "application/pdf", data: btoa("%PDF-1.4 synthetic") } }],
    } }] },
  }) }));
  const view = render(<SmartEvidencePage sessionToken={"a".repeat(43)} />);
  const link = await screen.findByRole("link", { name: "Download verified synthetic source PDF" });
  expect(link).toHaveAttribute("href", "blob:synthetic-pdf");
  expect(link).toHaveAttribute("download", "synthetic-source.pdf");
  expect(create).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledOnce();
  view.rerender(<SmartEvidencePage sessionToken={null} />);
  expect(revoke).toHaveBeenCalledWith("blob:synthetic-pdf");
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
