// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
const t = (key: string) => key;
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }));
import { DepartmentAudienceField } from '../components/DepartmentAudienceField';
const departments = [
  { id: 'p', name: 'Parent', parentId: null },
  { id: 'c', name: 'Child', parentId: 'p' },
  { id: 's', name: 'Sibling', parentId: 'p' },
];
const load = vi.fn();
const valid = vi.fn();
function Fixture({ initial = [] }: { initial?: string[] }) {
  const [mode, setMode] = useState<'all' | 'departments'>('departments');
  const [selected, setSelected] = useState(initial);
  return <><DepartmentAudienceField mode={mode} selected={selected} onValidityChange={valid}
    onChange={(nextMode, next) => { setMode(nextMode); setSelected(next); }} /><output data-testid="selection">{JSON.stringify(selected)}</output></>;
}
beforeEach(() => {
  vi.clearAllMocks(); setDataOwnerGeneration('owner-a', 1);
  load.mockResolvedValue({ success: true, audienceSupported: true, departments });
  vi.stubGlobal('electronAPI', { skillhub: { getMyDepts: load } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe('Department audience selection', () => {
  it('includes descendants, removes redundant IDs and does not promote all children', async () => {
    render(<Fixture />);
    await screen.findByText('Parent');
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.audience.expand' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Child' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Sibling' }));
    expect(screen.getByTestId('selection').textContent).toBe('["c","s"]');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Parent' }));
    expect(screen.getByTestId('selection').textContent).toBe('["p"]');
    expect((screen.getByRole('checkbox', { name: /Child/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Parent' }));
    await waitFor(() => expect(valid).toHaveBeenLastCalledWith(false));
  });
  it('finds descendants with their ancestors while preserving selection', async () => {
    render(<Fixture initial={['s']} />);
    await screen.findByText('Parent');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Child' } });
    expect(screen.getByRole('checkbox', { name: 'Child' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Parent' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Sibling' })).toBeNull();
    expect(screen.getByTestId('selection').textContent).toBe('["s"]');
  });
  it('keeps invalid selections visible and never silently widens the audience', async () => {
    render(<Fixture initial={['deleted']} />);
    await screen.findByText('skillhub.audience.invalid');
    expect(valid).toHaveBeenLastCalledWith(false);
    expect(screen.getByTestId('selection').textContent).toBe('["deleted"]');
    expect(screen.getByRole('button', { name: /skillhub.audience.unavailable/ })).toBeTruthy();
  });
  it('blocks old servers and permits retry after a failed lookup', async () => {
    load.mockResolvedValueOnce({ success: true, ids: [], names: [] });
    render(<Fixture initial={['p']} />);
    await screen.findByRole('alert');
    expect(valid).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.audience.retry' }));
    await screen.findByText('Parent', { selector: 'label' });
    await waitFor(() => expect(valid).toHaveBeenLastCalledWith(true));
  });
});
