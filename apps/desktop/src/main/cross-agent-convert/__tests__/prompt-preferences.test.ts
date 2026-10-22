import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  root: '',
}));
vi.mock('electron', () => ({
  app: { getPath: () => ipc.root },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      ipc.handlers.set(name, handler),
  },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../security/trustedAppRenderer.js', () => ({
  assertTrustedAppRendererEvent: (event: { trusted?: boolean }) => {
    if (!event.trusted) throw new Error('PERMISSION_DENIED');
  },
}));

vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
import { createMigrationPromptPreferences } from '../prompt-preferences.js';
import { registerCrossAgentConvertIpc, CROSS_AGENT_CHANNELS } from '../ipc.js';

// Production store, observable persisted choices. Bug: Cancel had no durable
// workspace option; no existing test covered restart/isolation/recovery. Minimal
// input: hide one of two directories, reopen store. Unit: isolated temporary files.
let root: string;
let settingsPath: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-prefs-'));
  settingsPath = path.join(root, 'profile', 'preferences.json');
  ipc.root = path.join(root, 'ipc-profile');
  registerCrossAgentConvertIpc();
});

// Same isolated fixture also exercises the actual IPC adapters. It closes the
// gap between stored overrides and the new-task detection result, including
// untrusted/invalid calls; no Electron process or real CLI is launched.
describe('migration prompt IPC', () => {
  const call = (channel: string, ...args: unknown[]) =>
    ipc.handlers.get(channel)!({ trusted: true }, ...args);
  it('hides only forward instructions and restores the next detection', async () => {
    const wd = path.join(root, 'project');
    await fs.mkdir(path.join(wd, '.codex', 'hooks'), { recursive: true });
    await fs.writeFile(path.join(wd, 'AGENTS.md'), '# instructions');
    expect(await call(CROSS_AGENT_CHANNELS.DETECT, wd, 'claude-code')).toMatchObject({
      items: [{ kind: 'agents-md' }, { kind: 'hooks' }],
    });
    await call(CROSS_AGENT_CHANNELS.PREFERENCES, 'suppress', wd);
    const hidden = await call(CROSS_AGENT_CHANNELS.DETECT, wd, 'claude-code');
    expect(hidden).toMatchObject({ items: [{ kind: 'hooks' }] });
    // P1 #6522: pre-create worktree detection inspects the base repository, but
    // that repository's saved choice must not hide a future worktree's prompt.
    expect(await call(CROSS_AGENT_CHANNELS.DETECT, wd, 'claude-code', false)).toMatchObject({
      items: [{ kind: 'agents-md' }, { kind: 'hooks' }],
    });
    // A forward choice must not hide the reverse conversion in the same directory.
    await fs.rename(path.join(wd, 'AGENTS.md'), path.join(wd, 'AGENTS.fixture-backup'));
    await fs.writeFile(path.join(wd, 'CLAUDE.md'), '# reverse instructions');
    expect(await call(CROSS_AGENT_CHANNELS.DETECT, wd, 'codex')).toMatchObject({
      items: [{ kind: 'agents-md', direction: 'to-codex' }],
    });
    await fs.unlink(path.join(wd, 'CLAUDE.md'));
    await fs.rename(path.join(wd, 'AGENTS.fixture-backup'), path.join(wd, 'AGENTS.md'));
    await call(CROSS_AGENT_CHANNELS.PREFERENCES, 'restore', wd);
    const restored = (await call(CROSS_AGENT_CHANNELS.DETECT, wd, 'claude-code')) as {
      items: unknown[];
    };
    expect(restored.items).toHaveLength(2);
  });

  it('rejects untrusted or invalid preference writes and leaves the list unchanged', async () => {
    const handler = ipc.handlers.get(CROSS_AGENT_CHANNELS.PREFERENCES)!;
    await expect(handler({}, 'suppress', root)).rejects.toThrow('PERMISSION_DENIED');
    for (const args of [
      ['unknown', root],
      ['suppress', '../relative'],
      ['restore', null],
    ]) {
      await expect(call(CROSS_AGENT_CHANNELS.PREFERENCES, ...args)).rejects.toThrow(
        'INVALID_ARGUMENT',
      );
    }
    expect(await call(CROSS_AGENT_CHANNELS.PREFERENCES, 'list')).toEqual([]);
  });
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const open = () => createMigrationPromptPreferences(() => settingsPath);

describe('workspace prompt preferences', () => {
  it('persists across store instances without hiding other workspaces', async () => {
    const first = path.join(root, 'first');
    const other = path.join(root, 'other');
    await open().setSuppressed(first, true);
    const reopened = open();
    expect(await reopened.isSuppressed(path.join(first, '.'))).toBe(true);
    expect(await reopened.isSuppressed(other)).toBe(false);
    await expect(fs.stat(path.join(first, '.cindy'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores only the selected directory and removes the final override', async () => {
    const first = path.join(root, 'first');
    const other = path.join(root, 'other');
    const store = open();
    await store.setSuppressed(first, true);
    await store.setSuppressed(other, true);
    await store.setSuppressed(first, false);
    expect(await open().isSuppressed(first)).toBe(false);
    expect(await open().isSuppressed(other)).toBe(true);
    await store.setSuppressed(other, false);
    await expect(fs.stat(settingsPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('merges writes from independent instances without losing earlier choices', async () => {
    const a = open();
    const b = open();
    a.list();
    b.list();
    await a.setSuppressed(path.join(root, 'first'), true);
    await b.setSuppressed(path.join(root, 'second'), true);
    expect(open().list()).toHaveLength(2);
  });

  it('restores a saved directory without clearing a new symlink target', async () => {
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    await fs.mkdir(first);
    await fs.mkdir(second);
    const store = open();
    await store.setSuppressed(first, true);
    await store.setSuppressed(second, true);
    const saved = store.list().find((entry) => entry.endsWith(`${path.sep}first`))!;
    await fs.rmdir(first);
    await fs.symlink(second, first, process.platform === 'win32' ? 'junction' : 'dir');
    await store.setSuppressed(saved, false);
    expect(store.list()).toHaveLength(1);
    expect(await store.isSuppressed(second)).toBe(true);
  });

  it('preserves unreadable preferences and rejects a false successful save', async () => {
    await fs.mkdir(path.dirname(settingsPath));
    await fs.writeFile(settingsPath, '{broken');
    const store = open();
    expect(store.list()).toEqual([]);
    await expect(store.setSuppressed(root, true)).rejects.toThrow();
    expect(await fs.readFile(settingsPath, 'utf8')).toBe('{broken');
  });
});
