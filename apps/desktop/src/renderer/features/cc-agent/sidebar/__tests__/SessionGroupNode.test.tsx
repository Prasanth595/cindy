// @vitest-environment jsdom
import React, { useState } from 'react';
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionGroupNode } from '../sections/ProjectsSection';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
// Empty groups do not exercise task rows or sibling project rendering.
vi.mock('../SessionEntryList', () => ({
  SessionEntryList: () => null,
  SessionEntryRows: () => null,
}));
vi.mock('../sections/ProjectNode', () => ({ ProjectNode: () => null }));
vi.mock('../sections/UnclassifiedSection', () => ({ UnclassifiedSection: () => null }));

afterEach(cleanup);

/**
 * #6575: the real group header must consume contextmenu before a sidebar ancestor
 * can open global sorting. Existing dialogueSidebarSection tests only scan source.
 * Minimal failing input: a bubbling right-click on the title of an empty group.
 * Unit tier: mount the real component in jsdom; no host, timers or network needed.
 * This separate file uses DOM behavior, unlike the existing static guard file.
 */
function Preview() {
  const [collapsed, setCollapsed] = useState(true);
  const [created, setCreated] = useState(0);
  const [globalMenu, setGlobalMenu] = useState(false);
  return (
    <div onContextMenu={() => setGlobalMenu(true)}>
      <SessionGroupNode
        sessions={[]}
        collapsed={collapsed}
        onToggle={() => setCollapsed((value) => !value)}
        onCreateDialogue={() => setCreated((value) => value + 1)}
        isCreateDisabled={false}
        parentSectionCollapsed={false}
        disableSessionCollapse={false}
        runningSessionIds={new Set()}
        attachedSessionIds={new Set()}
        notifications={new Set()}
        scheduleSessionIndex={new Map()}
        onSessionClick={vi.fn()}
        onAction={vi.fn()}
        onRename={vi.fn()}
        onTogglePin={vi.fn()}
        onScheduleAction={vi.fn()}
        sessionVariant="text"
      />
      <output aria-label="created">{created}</output>
      {globalMenu && <div role="menu">Global sorting</div>}
    </div>
  );
}

describe('SessionGroupNode context menu boundary (#6575)', () => {
  it('consumes title and nested create-button right-clicks without opening global sorting', () => {
    render(<Preview />);
    for (const target of [
      screen.getByText('ccAgent.sidebar.dialogues'),
      screen.getByRole('button', { name: 'ccAgent.sidebar.newDialogue' }),
    ]) {
      const event = createEvent.contextMenu(target, { bubbles: true, cancelable: true });
      fireEvent(target, event);
      expect(screen.queryByRole('menu')).toBeNull();
      expect(event.defaultPrevented).toBe(true);
    }
    expect(screen.getByRole('button', { expanded: false })).not.toBeNull();
    expect(screen.getByLabelText('created').textContent).toBe('0');
  });

  it('preserves click, Enter and Space toggling and isolates creation from the header', () => {
    render(<Preview />);
    const header = screen.getByRole('button', { expanded: false });
    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(header, { key: 'Enter' });
    expect(header.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(header, { key: ' ' });
    expect(header.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.sidebar.newDialogue' }));
    expect(screen.getByLabelText('created').textContent).toBe('1');
    expect(header.getAttribute('aria-expanded')).toBe('true');
  });
});
