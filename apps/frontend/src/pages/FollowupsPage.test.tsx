import { screen, within } from '@testing-library/react';
import type { Role } from '@telesphoros/shared-types';
import { describe, expect, it, vi } from 'vitest';
import { RECOVERY_SCOPE, renderApp } from '@/test/authTestUtils';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const NOW = '2026-11-01T12:00:00.000Z';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const emptyPage = { data: [], meta: { page: 1, pageSize: 20, total: 0, totalPages: 0 } };

/** Signed in with `roles`; the follow-up list has one overdue and two due today. */
function open(path: string, roles: Role[]) {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const at = new URL(String(input), 'http://synthetic');
    if (at.pathname.endsWith('/me/recovery-scope')) return json({ recoveryScope: RECOVERY_SCOPE });
    if (at.pathname === '/api/v1/followups')
      return json({ currentActor: 'person-1', items: [], page: 1, hasMore: false, counts: { overdue: 1, today: 2, upcoming: 0, unassigned: 0 } });
    if (at.pathname === '/api/v1/followups/availability') return json({ recording: 'enabled' });
    if (at.pathname.endsWith('/demographics')) return json({ error: { details: [{ reason: 'no-demographics' }] } }, 404);
    if (at.pathname.endsWith('/medications')) return json({ items: [] });
    if (at.pathname === `/api/v1/patients/${ID}`) return json({ id: ID, label: 'SYN-004', createdAt: NOW, updatedAt: NOW, mergedInto: null });
    if (at.pathname.includes('/patients') || at.pathname.includes('/reports') || at.pathname.includes('/evaluations')) return json(emptyPage);
    return json({ roles });
  });
  renderApp(path, { signedInAs: roles, fetchImpl });
}
const primary = () => within(screen.getByRole('navigation', { name: 'Primary' }));

describe('one way to move around (specs/041 slice C)', () => {
  it('opens Follow-ups as a page from the sidebar link, which keeps its count and marks the current page (C2)', async () => {
    open('/follow-ups', ['clinician']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Follow-ups' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Follow-ups' })).not.toBeInTheDocument();
    const link = await primary().findByRole('link', { name: 'Follow-ups (3)' });
    expect(link).toHaveAttribute('href', '/follow-ups');
    expect(link).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByText('Clinic totals: 1 overdue · 2 due today · 0 upcoming')).toBeInTheDocument();
  });

  it('keeps Follow-ups for the roles that read them: a reader has no link and is refused the page', async () => {
    open('/follow-ups', ['reader']);
    expect(await screen.findByRole('heading', { level: 1, name: 'You do not have access to this page' })).toBeInTheDocument();
    expect(primary().queryByRole('link', { name: /^Follow-ups/ })).not.toBeInTheDocument();
  });

  it('shows Reports as a page, not a panel over the chat (C1)', async () => {
    open('/reports', ['clinician']);
    expect(await screen.findByRole('heading', { level: 1, name: 'Reports' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Report history' })).not.toBeInTheDocument();
  });

  it('puts a breadcrumb on a patient record, beside the link back to the conversation in progress (C4)', async () => {
    open(`/patients/${ID}`, ['clinician']);
    const crumbs = within(await screen.findByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Patients' })).toHaveAttribute('href', '/patients');
    expect(crumbs.getByText('SYN-004')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Back to chat' })).toHaveAttribute('href', '/workspace');
  });

  it('puts the same breadcrumb on the new-patient form', async () => {
    open('/patients/new', ['clinician']);
    const crumbs = within(await screen.findByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Patients' })).toHaveAttribute('href', '/patients');
    expect(crumbs.getByText('New patient')).toHaveAttribute('aria-current', 'page');
  });
});
