// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { getMobileAuthOwner } from '../auth/authOwnerGeneration';
import { useSideChatCount } from '../session/useSideChatCount';

const summaryStore = vi.hoisted(() => ({
  rows: [] as any[], listeners: new Set<() => void>(),
  reseed: new Map<string, Set<() => void>>(),
}));
vi.mock('../session/remoteSessionStore', () => ({ remoteSessionStore: {
  getSessions: () => summaryStore.rows,
  subscribe: (listener: () => void) => { summaryStore.listeners.add(listener); return () => summaryStore.listeners.delete(listener); },
  registerReseedHandler: (deviceId: string, listener: () => void) => {
    let handlers = summaryStore.reseed.get(deviceId);
    if (!handlers) summaryStore.reseed.set(deviceId, handlers = new Set());
    handlers.add(listener);
    return () => handlers.delete(listener);
  },
} }));
const Focus = React.createContext(true);
vi.mock('expo-router', () => ({ useFocusEffect: (callback: () => (() => void) | undefined) => {
  const focused = React.useContext(Focus);
  React.useEffect(() => focused ? callback() : undefined, [focused, callback]);
} }));

// Unit: new picker lifecycle. A native close callback arrives after visible=false;
// selection must survive that render, but not a reopen or a different task's load.
// Execute production hooks; only native presentation and theme are substituted.
const source = ts.createSourceFile('SideChatsSheet.tsx', readFileSync(resolve(process.cwd(), 'src/session/SideChatsSheet.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'SideChatsSheet');
if (!component) throw new Error('SideChatsSheet production component is missing');
const sheet = { props: null as any };
const native = ({ children }: any) => <div>{children}</div>;
const translate = (key: string) => key;
const bindings = {
  React, useCallback: React.useCallback, useEffect: React.useEffect, useMemo: React.useMemo,
  useRef: React.useRef, useState: React.useState, useTranslation: () => ({ t: translate }),
  View: native, Text: native, ActivityIndicator: () => null, Platform: { OS: 'android' },
  useTheme: () => ({ colors: {} }), useThemedStyles: () => ({}), makeStyles: () => ({}),
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }), useWindowDimensions: () => ({ height: 800 }),
  computeContextSheetSnapHeights: () => ({}), SheetSurface: native,
  SheetModal: (props: any) => { sheet.props = props; return <div>{props.children}</div>; },
  MainWindowActionButton: ({ action }: any) => <button data-testid={action.testID} disabled={action.disabled} onClick={action.onPress}>{action.label}</button>,
  ErrorNotice: ({ message }: any) => <div>{message}</div>,
};
const compiled = ts.transpileModule(component.getText(source).replace('export function', 'function') + '; return SideChatsSheet;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
}).outputText;
const Picker = new Function(...Object.keys(bindings), compiled)(...Object.values(bindings));
const main = { id: 'main', status: 'active' };
const child = { id: 'child', source: 'side-chat', parentSessionId: main.id, status: 'active' };

describe('side chat picker', () => {
  it('navigates once after native dismissal; reopening cancels an old selection', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div'), root = createRoot(host);
    const maker = { listSideChats: vi.fn(async () => [child]), getSession: vi.fn(async (id: string) => id === main.id ? main : child) };
    const onSelect = vi.fn(), onClose = vi.fn();
    const update = async (visible: boolean) => act(async () => root.render(<Picker visible={visible} session={main} maker={maker} onSelect={onSelect} onClose={onClose} onCreate={async () => child} />));
    try {
      await update(true);
      act(() => host.querySelector<HTMLButtonElement>('[data-testid="session.sideChat.open.child"]')!.click());
      expect(onClose).toHaveBeenCalledTimes(1); expect(onSelect).not.toHaveBeenCalled();
      await update(false);
      act(() => { sheet.props.onClosed(); sheet.props.onClosed(); });
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(child);
      onSelect.mockClear(); await update(true);
      act(() => host.querySelector<HTMLButtonElement>('[data-testid="session.sideChat.create"]')!.click());
      await act(async () => {});
      await update(false); await update(true); await update(false);
      act(() => sheet.props.onClosed());
      expect(onSelect).not.toHaveBeenCalled();
    } finally { act(() => root.unmount()); }
  });

  it('ignores a previous task list that completes after switching tasks', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div'), root = createRoot(host);
    let finish!: (rows: typeof child[]) => void;
    const maker = { listSideChats: vi.fn((id: string) => id === main.id ? new Promise<typeof child[]>(resolve => { finish = resolve; }) : Promise.resolve([])), getSession: vi.fn(async (id: string) => id === child.id ? child : { ...main, id }) };
    const render = async (id: string) => act(async () => root.render(<Picker visible session={{ ...main, id }} maker={maker} onClose={() => {}} onSelect={() => {}} onCreate={async () => null} />));
    try {
      await render(main.id); await render('other');
      await act(async () => finish([child]));
      expect(host.querySelector('[data-testid="session.sideChat.open.child"]')).toBeNull();
      expect(host.querySelector<HTMLButtonElement>('[data-testid="session.sideChat.create"]')?.disabled).toBe(false);
    } finally { act(() => root.unmount()); }
  });
});

// Unit: the low-frequency summary must reflect the host list (including unseen
// children), disappear after the last deletion, and never leak a late count to
// a different task. Picker-only coverage above does not exercise this query.
describe('side chat summary count', () => {
  function mount(maker: Parameters<typeof useSideChatCount>[0]['maker']) {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    summaryStore.rows = [];
    const host = document.createElement('div'), root = createRoot(host);
    const Probe = (props: { sessionId: string; enabled: boolean; refreshKey: string }) =>
      <output>{useSideChatCount({ ...props, deviceId: 'device', maker, owner: getMobileAuthOwner() })}</output>;
    return {
      count: () => Number(host.textContent),
      render: async ({ sessionId = 'main', enabled = true, focused = true, refreshKey = '' } = {}) => act(async () => {
        root.render(<Focus.Provider value={focused}><Probe sessionId={sessionId} enabled={enabled} refreshKey={refreshKey} /></Focus.Provider>);
      }),
      close: () => act(() => root.unmount()),
    };
  }

  it('counts unseen host children and refreshes after focus and picker changes', async () => {
    const listSideChats = vi.fn(async () => [] as { id: string }[]);
    const ui = mount({ listSideChats });
    try {
      await ui.render({ enabled: false });
      expect(ui.count()).toBe(0); expect(listSideChats).not.toHaveBeenCalled();
      await ui.render(); expect(ui.count()).toBe(0);
      await ui.render({ focused: false });
      listSideChats.mockResolvedValue([{ id: 'unseen' }, { id: 'another' }]);
      await ui.render(); expect(ui.count()).toBe(2);
      listSideChats.mockResolvedValue([]);
      await ui.render({ refreshKey: 'picker-closed' }); expect(ui.count()).toBe(0);
    } finally { ui.close(); }
  });

  it('updates on child membership changes, but does not query on unrelated store notifications', async () => {
    const listSideChats = vi.fn(async () => [] as { id: string }[]);
    const ui = mount({ listSideChats });
    const notify = async (rows: any[]) => act(async () => {
      summaryStore.rows = rows; summaryStore.listeners.forEach(listener => listener());
    });
    try {
      await ui.render();
      await notify([{ ...child, deviceLinkDeviceId: 'another-device' }]);
      expect(listSideChats).toHaveBeenCalledTimes(1); expect(ui.count()).toBe(0);
      listSideChats.mockResolvedValue([child]);
      await notify([{ ...child, deviceLinkDeviceId: 'device' }]);
      expect(ui.count()).toBe(1);
      listSideChats.mockResolvedValue([]);
      await notify([]); expect(ui.count()).toBe(0);
    } finally { ui.close(); }
    expect(summaryStore.listeners.size).toBe(0);
  });

  // Regression: sessions:created carries only an id, and side chats are excluded
  // from the ordinary list. The existing membership tests cannot see this event.
  // remoteSessionStore.test.ts covers push -> per-device reseed dispatch.
  it('refreshes unseen children from a device reseed while the parent stays focused', async () => {
    const listSideChats = vi.fn(async () => [] as { id: string }[]);
    const ui = mount({ listSideChats });
    const created = (deviceId: string) => act(async () => {
      summaryStore.reseed.get(deviceId)?.forEach(listener => listener());
    });
    try {
      await ui.render();
      listSideChats.mockResolvedValue([child]);
      await created('another-device');
      expect(listSideChats).toHaveBeenCalledTimes(1);
      await created('device');
      expect(ui.count()).toBe(1);
      expect(summaryStore.rows).toEqual([]);
      listSideChats.mockResolvedValue([]);
      await created('device');
      expect(ui.count()).toBe(0);
      await ui.render({ focused: false });
      await created('device');
      expect(listSideChats).toHaveBeenCalledTimes(3);
    } finally { ui.close(); }
    expect(summaryStore.reseed.get('device')?.size ?? 0).toBe(0);
  });

  it('ignores late results after switching tasks or after a newer refresh', async () => {
    const pending: Array<(rows: { id: string }[]) => void> = [];
    const ui = mount({ listSideChats: () => new Promise(resolve => pending.push(resolve)) });
    try {
      await ui.render(); await ui.render({ sessionId: 'other' });
      await act(async () => pending[0]!([child])); expect(ui.count()).toBe(0);
      await ui.render({ sessionId: 'other', refreshKey: 'newer' });
      await act(async () => pending[2]!([]));
      await act(async () => pending[1]!([child])); expect(ui.count()).toBe(0);
    } finally { ui.close(); }
  });

  it('leaves the optional entry absent on an older host without list support', async () => {
    const ui = mount({ listSideChats: async () => { throw new Error('CHANNEL_NOT_ALLOWED'); } });
    try { await ui.render(); expect(ui.count()).toBe(0); } finally { ui.close(); }
  });
});
