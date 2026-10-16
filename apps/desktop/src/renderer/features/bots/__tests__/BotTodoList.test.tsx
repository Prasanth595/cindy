// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TeammateTodo } from '@cindy/maker-shared/teammate-todo';
import { TodoPanel, type TodoTransport } from '../BotTodoList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key.replace('teammateTodo.', ''),
    i18n: { language: 'en' },
  }),
}));

beforeAll(() => {
  // jsdom lacks the pointer and scrolling APIs used by the real Radix Select.
  window.HTMLElement.prototype.hasPointerCapture ??= () => false;
  window.HTMLElement.prototype.setPointerCapture ??= () => {};
  window.HTMLElement.prototype.releasePointerCapture ??= () => {};
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
afterEach(cleanup);

function todo(id: string, patch: Partial<TeammateTodo> = {}): TeammateTodo {
  return {
    id,
    revision: 1,
    key: id,
    origin: 'assigned',
    title: id,
    progress: '',
    outcome: '',
    value: '',
    next: null,
    sources: [],
    associations: [],
    status: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    sourceDeadline: null,
    deadlineCandidate: null,
    suggestedDate: null,
    decision: null,
    history: [],
    action: null,
    ...patch,
  };
}

async function mount(items: TeammateTodo[]) {
  const transport: TodoTransport = {
    list: vi.fn(async () => ({ items })),
    update: vi.fn(),
    act: vi.fn(),
  };
  const view = render(<TodoPanel transport={transport} />);
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  return { ...view, transport };
}

async function choose(label: string, option: string) {
  const user = userEvent.setup();
  const trigger = screen.getByRole('combobox', { name: label });
  trigger.focus();
  await user.keyboard('{ArrowDown}');
  await user.click(await screen.findByRole('option', { name: option }));
  await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
}

describe('TodoPanel filters', () => {
  it('uses the shared themed Select for all three filters, without native selects', async () => {
    const { container } = await mount([]);
    expect(container.querySelector('select')).toBeNull();
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
    for (const [label, value] of [
      ['open', 'open'],
      ['origin', 'all'],
      ['order', 'dueOrder'],
    ]) {
      const trigger = screen.getByRole('combobox', { name: label });
      expect(trigger.textContent).toBe(value);
      expect(trigger.className).toContain('cindy-button');
      expect(trigger.className).toContain('rounded-full');
      expect(trigger.getAttribute('data-press-feedback')).toBe('none');
    }
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'open' }), { key: 'ArrowDown' });
    const panel = await screen.findByRole('listbox');
    expect(container.contains(panel)).toBe(false);
    expect(panel.className).toContain('w-[var(--radix-select-trigger-width)]');
    expect(panel.className).toContain('bg-[var(--surface-elevated)]');
    expect(screen.getByRole('option', { name: 'open' }).getAttribute('aria-selected')).toBe('true');
  });

  it('switches between open and hidden todos without mutating the transport', async () => {
    const { transport } = await mount([
      todo('active'),
      todo('ignored', { decision: { kind: 'muted' } }),
    ]);
    expect(screen.queryByRole('button', { name: 'ignored' })).toBeNull();
    await choose('open', 'hidden');
    expect(screen.getByRole('button', { name: 'ignored' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'active' })).toBeNull();
    await choose('open', 'open');
    expect(screen.getByRole('button', { name: 'active' })).toBeTruthy();
    expect(transport.update).not.toHaveBeenCalled();
    expect(transport.act).not.toHaveBeenCalled();
  });

  it('combines origin selection with search for open and completed todos', async () => {
    await mount([
      todo('assigned match'),
      todo('discovered match', { origin: 'discovered' }),
      todo('assigned done match', { status: 'done' }),
      todo('discovered done match', { status: 'done', origin: 'discovered' }),
      todo('discovered other', { origin: 'discovered' }),
    ]);
    fireEvent.change(screen.getByRole('textbox', { name: 'search' }), {
      target: { value: 'match' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'done · 2' }));
    await choose('origin', 'discovered');
    expect(screen.getByRole('button', { name: 'discovered match' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'discovered done match' })).toBeTruthy();
    for (const name of ['assigned match', 'assigned done match', 'discovered other']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    await choose('origin', 'assigned');
    expect(screen.getByRole('button', { name: 'assigned match' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'assigned done match' })).toBeTruthy();
  });

  it('reorders both open and completed lists using the existing comparators', async () => {
    const deadline = { kind: 'date', date: '2026-12-01', timeZone: 'UTC' } as const;
    const { container } = await mount([
      todo('older'),
      todo('due', { createdAt: '2026-02-01T00:00:00Z', sourceDeadline: deadline }),
      todo('older done', { status: 'done' }),
      todo('due done', {
        status: 'done',
        createdAt: '2026-02-01T00:00:00Z',
        sourceDeadline: deadline,
      }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'done · 2' }));
    const ids = () =>
      Array.from(container.querySelectorAll('[data-todo-id]'), (row) =>
        row.getAttribute('data-todo-id'),
      );
    expect(ids()).toEqual(['due', 'older', 'due done', 'older done']);
    await choose('order', 'createdOrder');
    expect(ids()).toEqual(['older', 'due', 'older done', 'due done']);
    await choose('order', 'dueOrder');
    expect(ids()).toEqual(['due', 'older', 'due done', 'older done']);
  });

  it.each([
    ['open', 'hidden'],
    ['origin', 'assigned'],
    ['order', 'createdOrder'],
  ])('resets both pagination controls when changing %s', async (label, option) => {
    await mount(
      Array.from({ length: 30 }, (_, index) => [
        todo(`assigned ${index}`),
        todo(`discovered ${index}`, { origin: 'discovered' }),
        todo(`hidden ${index}`, { decision: { kind: 'muted' } }),
        todo(`done ${index}`, { status: 'done' }),
      ]).flat(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'done · 30' }));
    for (const next of screen.getAllByRole('button', { name: 'following' })) fireEvent.click(next);
    expect(
      screen
        .getAllByRole<HTMLButtonElement>('button', { name: 'previous' })
        .every((button) => !button.disabled),
    ).toBe(true);
    await choose(label, option);
    expect(
      screen
        .getAllByRole<HTMLButtonElement>('button', { name: 'previous' })
        .every((button) => button.disabled),
    ).toBe(true);
  });

  it('supports keyboard selection, Escape dismissal and returning focus to the trigger', async () => {
    await mount([]);
    const user = userEvent.setup();
    const trigger = screen.getByRole('combobox', { name: 'open' });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await screen.findByRole('listbox');
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('option', { name: 'open' })),
    );
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(trigger.textContent).toBe('hidden');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    await user.keyboard('{Enter}');
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(trigger.textContent).toBe('hidden');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
});
