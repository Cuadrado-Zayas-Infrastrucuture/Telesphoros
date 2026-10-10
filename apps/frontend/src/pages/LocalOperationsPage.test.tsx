/** @vitest-environment-options {"url":"http://127.0.0.1:4180"} */
import { render, screen, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, it, expect, vi } from "vitest";
import LocalOperationsPage from "./LocalOperationsPage";
const mocks = vi.hoisted(() => ({ roles: ["reviewer"], apiFetch: vi.fn() }));
vi.mock("@/auth/AuthProvider", () => ({ useAuth: () => mocks }));
beforeEach(() => {
  mocks.roles = ["reviewer"];
  mocks.apiFetch.mockReset();
});
const renderPage = () =>
  render(
    <MemoryRouter>
      <LocalOperationsPage />
    </MemoryRouter>,
  );
it("does not fetch or write on initial render and requires explicit confirmation", () => {
  renderPage();
  expect(mocks.apiFetch).not.toHaveBeenCalled();
  expect(screen.getByText("Raise dispute")).toBeDisabled();
  fireEvent.click(
    screen.getByLabelText(
      "I reviewed the selected record and intend this synthetic change",
    ),
  );
  expect(screen.getByText("Raise dispute")).toBeEnabled();
});
it("clinician cannot raise even after confirmation", () => {
  mocks.roles = ["clinician"];
  renderPage();
  fireEvent.click(
    screen.getByLabelText(
      "I reviewed the selected record and intend this synthetic change",
    ),
  );
  expect(screen.getByText("Raise dispute")).toBeDisabled();
});
it("editing the cell after confirming requires a new confirmation", () => {
  renderPage();
  fireEvent.click(
    screen.getByLabelText(
      "I reviewed the selected record and intend this synthetic change",
    ),
  );
  fireEvent.change(screen.getByLabelText("Row"), {
    target: { value: "Intermediate Metabolizer" },
  });
  expect(screen.getByText("Raise dispute")).toBeDisabled();
});
it("only admin is offered the full-ledger control", () => {
  renderPage();
  expect(screen.queryByText("Verify full ledger")).not.toBeInTheDocument();
});

it("links dispute errors to their fields, focuses the first and makes no request", async () => {
  renderPage();
  fireEvent.click(
    screen.getByLabelText(
      "I reviewed the selected record and intend this synthetic change",
    ),
  );
  fireEvent.click(screen.getByText("Raise dispute"));
  const field = screen.getByLabelText("Guideline ID");
  expect(await screen.findByText("Enter a guideline ID.")).toBeVisible();
  expect(field).toHaveAttribute("aria-invalid", "true");
  expect(field).toHaveAccessibleDescription("Enter a guideline ID.");
  expect(field).toHaveFocus();
  expect(mocks.apiFetch).not.toHaveBeenCalled();
});
it("preserves dispute inputs after refusal and disables repeat submission while busy", async () => {
  let finish!: (value: Response) => void;
  mocks.apiFetch.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  renderPage();
  for (const [label, value] of [
    ["Guideline ID", "synthetic-guideline"],
    ["Table", "Table 1"],
    ["Row", "Normal"],
    ["Synthetic note or decision evidence", "Synthetic reason"],
  ])
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(
    screen.getByLabelText(
      "I reviewed the selected record and intend this synthetic change",
    ),
  );
  fireEvent.click(screen.getByText("Raise dispute"));
  expect(screen.getByText("Raise dispute")).toBeDisabled();
  fireEvent.click(screen.getByText("Raise dispute"));
  expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
  finish(new Response("{}", { status: 503 }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Request refused");
  expect(screen.getByLabelText("Guideline ID")).toHaveValue(
    "synthetic-guideline",
  );
  expect(
    screen.getByLabelText("Synthetic note or decision evidence"),
  ).toHaveValue("Synthetic reason");
  expect(screen.getByText("Raise dispute")).toBeEnabled();
});

it('allows only one history request from two same-turn clicks',()=>{mocks.apiFetch.mockReturnValue(new Promise(()=>{}));renderPage();const button=screen.getByText('Refresh evaluations');act(()=>{button.dispatchEvent(new MouseEvent('click',{bubbles:true}));button.dispatchEvent(new MouseEvent('click',{bubbles:true}));});expect(mocks.apiFetch).toHaveBeenCalledTimes(1);});
