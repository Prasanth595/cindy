// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
const t = (key: string) => key;
vi.mock('react-i18next', async (original) => ({ ...await original<typeof import('react-i18next')>(), useTranslation: () => ({ t }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { membershipKind: 'org' } }) }));
vi.mock('../hooks/useSkillhubIdentityPolicy', () => ({ useSkillhubIdentityPolicy: () => ({ allowedVisibilities: ['PUBLIC', 'DEPARTMENT_SCOPED'] }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../PublishDialog', () => ({ VisibilityCard: ({ label, onSelect, value }: { label: string; onSelect: (value: string) => void; value: string }) =>
  <button onClick={() => onSelect(value)}>{label}</button> }));
import { VisibilityEditorDialog } from '../components/VisibilityEditorDialog';
const load = vi.fn(); const save = vi.fn(); const close = vi.fn(); const saved = vi.fn();
const updatedAt = '2026-01-01T00:00:00.000Z';
beforeEach(() => {
  vi.clearAllMocks(); setDataOwnerGeneration('owner-a', 1);
  load.mockResolvedValue({ success: true, audienceSupported: true, visibleDepts: ['p'], updatedAt, visibility: 'shared' });
  save.mockResolvedValue({ success: true });
  vi.stubGlobal('electronAPI', { skillhub: {
    getPublishedVisibility: load, setPublishedVisibility: save,
    getMyDepts: vi.fn().mockResolvedValue({ success: true, audienceSupported: true, departments: [{ id: 'p', name: 'Parent', parentId: null }] }),
  } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function open() { return render(<VisibilityEditorDialog open onOpenChange={close} skillName="demo" currentTier="team" currentOwnerType="org" onSaved={saved} />); }
it('loads saved audience and sends the concurrency version when saving', async () => {
  open();
  await waitFor(() => expect((screen.getByRole('button', { name: 'skillhub.visibilityEditor.save' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'skillhub.visibilityEditor.save' }));
  await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
    expectedUpdatedAt: updatedAt, visibilityDepartmentIds: ['p'], audienceMode: 'departments',
  })));
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
});
it('retains the selection on conflict and provides explicit reload', async () => {
  save.mockResolvedValue({ success: false, errorCode: 'SKILL_DISTRIBUTION_CONFLICT', error: 'Conflict' });
  open();
  await waitFor(() => expect((screen.getByRole('button', { name: 'skillhub.visibilityEditor.save' }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'skillhub.visibilityEditor.save' }));
  await screen.findByText('skillhub.audience.conflict');
  expect(close).not.toHaveBeenCalled();
  expect((screen.getByRole('checkbox', { name: 'Parent' }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'skillhub.audience.reload' }));
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
});
it('keeps failed loading retryable and does not save on cancellation', async () => {
  load.mockResolvedValueOnce({ success: false });
  open();
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'skillhub.audience.retry' }));
  await screen.findByRole('checkbox', { name: 'Parent' });
  fireEvent.click(screen.getByRole('button', { name: 'skillhub.publishDialog.cancel' }));
  expect(save).not.toHaveBeenCalled();
});

it.each(['org', 'organization'])('rejects old visibility capability for %s ownership', async (owner) => {
  load.mockResolvedValue({ success: true, visibleDepts: [] });
  render(<VisibilityEditorDialog open onOpenChange={close} skillName="demo" currentTier="team" currentOwnerType={owner} onSaved={saved} />);
  await screen.findByRole('alert');
  expect((screen.getByRole('button', { name: 'skillhub.visibilityEditor.save' }) as HTMLButtonElement).disabled).toBe(true);
  expect(save).not.toHaveBeenCalled();
});

it.each(['loading', 'loaded'])('closes after same-owner generation changes while %s', async (phase) => {
  if (phase === 'loading') load.mockReturnValueOnce(new Promise(() => {}));
  const view = open();
  if (phase === 'loaded') await screen.findByRole('checkbox', { name: 'Parent' });
  setDataOwnerGeneration('owner-a', 2);
  view.rerender(<VisibilityEditorDialog open onOpenChange={close} skillName="demo" currentTier="team" currentOwnerType="org" onSaved={saved} />);
  await waitFor(() => expect(close).toHaveBeenCalledWith(false));
  expect(save).not.toHaveBeenCalled();
});
