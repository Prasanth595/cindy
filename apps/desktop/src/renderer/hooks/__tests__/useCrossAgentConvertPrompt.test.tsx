// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  suppressAgentsMdPrompt: vi.fn(),
  convert: vi.fn(),
  onStep: vi.fn(() => () => {}),
}));
const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('@/lib/crossAgentConvertService', () => ({ crossAgentConvertService: api }));
vi.mock('@/lib/toast', () => ({ toast }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { useCrossAgentMigrationDialog } from '../useCrossAgentConvertPrompt';
import { CrossAgentConvertDialog } from '@/components/ui/cross-agent-convert-dialog';

// Production hook + dialog: a persistent skip must not convert files or skip other
// items, and a failed save must not pretend it succeeded. Previously no hook tests
// covered cancel/persistence. Minimal input: one agents-md item. Unit, simulated IPC.
let dialog: ReturnType<typeof useCrossAgentMigrationDialog>;
function Harness() {
  dialog = useCrossAgentMigrationDialog();
  return <CrossAgentConvertDialog {...dialog} />;
}
const instruction: CrossAgentMigrationItem = {
  id: 'agents-md:0',
  kind: 'agents-md',
  direction: 'to-claude',
  label: 'AGENTS.md → CLAUDE.md',
  source: '/workspace/AGENTS.md',
  target: '/workspace/CLAUDE.md',
};
const hooks: CrossAgentMigrationItem = {
  ...instruction,
  id: 'hooks:0',
  kind: 'hooks',
  label: 'Hooks',
};
beforeEach(() => {
  vi.clearAllMocks();
  api.suppressAgentsMdPrompt.mockResolvedValue(['/workspace']);
  render(<Harness />);
});
afterEach(cleanup);
const open = (items = [instruction]) => {
  let finished!: Promise<void>;
  act(() => {
    finished = dialog.runMigrationFlow(items, '/workspace');
  });
  return finished;
};

describe('migration prompt decisions', () => {
  // P1 #6522: before a generated worktree exists, there is no physical directory
  // to persist. Unit: actual hook/dialog, null target + one item; old UI offered
  // a save anyway. Existing tests only covered concrete workspace paths.
  it('keeps conversion and cancel available without a persistent choice before worktree creation', async () => {
    let finished!: Promise<void>;
    act(() => { finished = dialog.runMigrationFlow([instruction], null); });
    expect(screen.queryByRole('button', { name: 'commonUi.crossAgentConvert.suppressAgentsMd' })).toBeNull();
    expect(screen.getByText(instruction.label)).toBeTruthy();
    api.convert.mockResolvedValueOnce({ total: 1, successCount: 1, skippedCount: 0, failedCount: 0 });
    await act(async () => { dialog.onConfirm(); await finished; });
    expect(api.convert).toHaveBeenCalledWith([instruction]);
    expect(api.suppressAgentsMdPrompt).not.toHaveBeenCalled();
  });

  it('ordinary cancel closes without persisting or converting', async () => {
    const finished = open();
    act(() => dialog.onCancel());
    await finished;
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.suppressAgentsMdPrompt).not.toHaveBeenCalled();
    expect(api.convert).not.toHaveBeenCalled();
  });

  it('hides the instruction prompt only after its preference has been saved', async () => {
    let saved!: (value: string[]) => void;
    api.suppressAgentsMdPrompt.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          saved = resolve;
        }),
    );
    const finished = open();
    act(() => {
      dialog.onSuppressAgentsMd!();
      dialog.onConfirm();
      dialog.onCancel();
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(api.convert).not.toHaveBeenCalled();
    await act(async () => {
      saved(['/workspace']);
      await finished;
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(api.suppressAgentsMdPrompt).toHaveBeenCalledWith('/workspace');
  });

  it('keeps unrelated items available after hiding AGENTS.md conversion', async () => {
    const finished = open([instruction, hooks]);
    await act(async () => {
      dialog.onSuppressAgentsMd!();
    });
    expect(screen.queryByText(instruction.label)).toBeNull();
    expect(screen.getByText('Hooks')).toBeTruthy();
    expect(api.convert).not.toHaveBeenCalled();
    act(() => dialog.onCancel());
    await finished;
  });

  it('keeps the prompt on a failed save and permits ordinary cancellation', async () => {
    api.suppressAgentsMdPrompt.mockRejectedValueOnce(new Error('disk full'));
    const finished = open();
    await act(async () => {
      dialog.onSuppressAgentsMd!();
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('commonUi.crossAgentConvert.preferenceFailed'),
    );
    expect(screen.getByText(instruction.label)).toBeTruthy();
    act(() => dialog.onCancel());
    await finished;
  });
});
