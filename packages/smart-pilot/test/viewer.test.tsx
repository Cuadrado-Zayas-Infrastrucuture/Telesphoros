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
