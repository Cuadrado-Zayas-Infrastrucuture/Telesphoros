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

const summary = {
  id: '11111111-1111-4111-8111-111111111111',
  reportId: '11111111-1111-4111-8111-111111111111', patientId: '11111111-1111-4111-8111-111111111111', captureId: '11111111-1111-4111-8111-111111111111',
  acceptance: null, disposition: 'held', holdCode: 'unsupported-layout', hold: { message: 'Synthetic hold', reviewerAction: 'Review' },
  knowledgeSetId: 'syn', engineVersion: 'test', scope: null, clinicalUse: 'not-approved', state: 'active', supersededBy: null,
  results: [], geneStates: [], corrections: [], current: true, advisory: { activeDisputes: 0, patientLink: 'verified' }, actionable: false, createdAt: 'now',
};
const response = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

it('keeps the displayed page after failed navigation, then replaces rows and clears the prior selection after success', async () => {
  mocks.apiFetch.mockResolvedValueOnce(response({ data: [summary], meta: { page: 1, pageSize: 20, total: 21, totalPages: 2 } }));
  renderPage();
  fireEvent.click(screen.getByText('Refresh evaluations'));
  await screen.findByText('Page 1 of 2. 21 records.');
  expect(screen.getByText('Previous evaluation page')).toBeDisabled();
  mocks.apiFetch.mockResolvedValueOnce(response({ ...summary, geneInputs: [] }));
  fireEvent.click(screen.getByText('Open ' + summary.id));
  await screen.findByText(/Selected:/);
  fireEvent.click(screen.getByLabelText('I reviewed the selected record and intend this synthetic change'));
  mocks.apiFetch.mockResolvedValueOnce(new Response('{}', { status: 503 }));
  fireEvent.click(screen.getByText('Next evaluation page'));
  await screen.findByRole('alert');
  expect(screen.getByText('Page 1 of 2. 21 records.')).toBeVisible();
  expect(screen.getByText('Open ' + summary.id)).toBeVisible();
  mocks.apiFetch.mockResolvedValueOnce(response({ data: [], meta: { page: 2, pageSize: 20, total: 21, totalPages: 2 } }));
  fireEvent.click(screen.getByText('Next evaluation page'));
  await screen.findByText('Page 2 of 2. 21 records.');
  expect(screen.queryByText('Open ' + summary.id)).not.toBeInTheDocument();
  expect(screen.queryByText(/Selected:/)).not.toBeInTheDocument();
  expect(screen.getByLabelText('I reviewed the selected record and intend this synthetic change')).not.toBeChecked();
  expect(screen.getByText('Next evaluation page')).toBeDisabled();
  expect(mocks.apiFetch).toHaveBeenLastCalledWith('/api/v1/evaluations?page=2&pageSize=20', {});
});

it('offers independent dispute pages and disables repeat navigation while a request is pending', async () => {
  mocks.apiFetch.mockResolvedValueOnce(response({ data: [], meta: { page: 1, pageSize: 20, total: 21, totalPages: 2 } }));
  renderPage();
  fireEvent.click(screen.getByText('Refresh disputes'));
  await screen.findByText('Next dispute page');
  let finish!: (value: Response) => void;
  mocks.apiFetch.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  fireEvent.click(screen.getByText('Next dispute page'));
  expect(screen.getByText('Next dispute page')).toBeDisabled();
  fireEvent.click(screen.getByText('Next dispute page'));
  expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
  finish(response({ data: [], meta: { page: 2, pageSize: 20, total: 21, totalPages: 2 } }));
  await screen.findByText('Page 2 of 2. 21 records.');
  expect(screen.getByText('Next dispute page')).toBeDisabled();
  expect(screen.getByText('Previous dispute page')).toBeEnabled();
  expect(mocks.apiFetch).toHaveBeenLastCalledWith('/api/v1/cell-disputes?page=2&pageSize=20', {});
});

it('shows an empty result and rejects the obsolete array response', async () => {
  mocks.apiFetch.mockResolvedValueOnce(response([]));
  renderPage();
  fireEvent.click(screen.getByText('Refresh evaluations'));
  await screen.findByRole('alert');
  expect(screen.queryByText('Next evaluation page')).not.toBeInTheDocument();
  mocks.apiFetch.mockResolvedValueOnce(response({ data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } }));
  fireEvent.click(screen.getByText('Refresh evaluations'));
  await screen.findByText('No records.');
  expect(screen.getByText('Next evaluation page')).toBeDisabled();
  expect(screen.getByText('Previous evaluation page')).toBeDisabled();
});
