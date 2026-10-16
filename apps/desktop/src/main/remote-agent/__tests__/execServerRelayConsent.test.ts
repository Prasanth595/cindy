/**
 * Codex exec-server 中继里的本机确认(供应商分享的受邀者任务)：凭证类操作等本机用户确认时，这条
 * 连接后面的消息按顺序排在它后面；允许才转给 exec-server，拒绝回 JSON-RPC 错误。
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawned = vi.hoisted(() => ({ lines: [] as string[], children: [] as Array<{ stdout: PassThrough }> }));

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill(): void;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => undefined;
    spawned.children.push(child);
    child.stdin.on('data', (chunk: Buffer) => {
      spawned.lines.push(...chunk.toString().split('\n').filter(Boolean));
    });
    return child;
  },
}));

import { ExecServerRelay } from '../controller/execServerRelay';
import { RemoteExecutor } from '../executor/executor';
import { ExecutorGate, type ExecutorAction, type ExecutorGateDecision } from '../executor/gate';
import { ExecutorWorkspace } from '../executor/workspace';

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-relay-consent-')));
  spawned.lines = [];
  spawned.children = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function setup(authorize?: (action: ExecutorAction) => ExecutorGateDecision, workspace = new ExecutorWorkspace({ workingDir: root })) {
  const approved = new Set<string>();
  const pending: Array<{ action: ExecutorAction; answer(allowed: boolean): void }> = [];
  const replies: Array<Record<string, unknown>> = [];
  const isSecret = (action: ExecutorAction) => action.kind !== 'fetch' && action.kind !== 'exec' && action.path.endsWith('.env');
  const relay = new ExecServerRelay({
    codexPath: 'codex',
    cwd: root,
    workspace,
    authorize: authorize ?? ((action): ExecutorGateDecision => {
      if (!isSecret(action)) return { ok: true };
      const key = action.kind === 'exec' || action.kind === 'fetch' ? '' : action.path;
      return approved.delete(key) ? { ok: true, elevated: true } : { ok: false, reason: 'needs confirmation' };
    }),
    confirm: (action) => new Promise<boolean>((resolve) => {
      pending.push({
        action,
        answer: (allowed) => {
          if (allowed && action.kind !== 'exec' && action.kind !== 'fetch') approved.add(action.path);
          resolve(allowed);
        },
      });
    }),
    push: async (frames) => {
      for (const frame of frames) if (frame.kind === 'message' && frame.data) replies.push(JSON.parse(frame.data));
    },
  });
  relay.handle({ t: 'ws', connId: 'c1', kind: 'open', path: '/ws/exec-server' });
  const send = (message: Record<string, unknown>) =>
    relay.handle({ t: 'ws', connId: 'c1', kind: 'message', data: JSON.stringify(message) });
  const sentIds = () => spawned.lines.map((line) => (JSON.parse(line) as { id?: unknown }).id);
  return { relay, pending, replies, send, sentIds };
}

describe('exec-server relay with confirmation on this computer', () => {
  it('uses an explicit session consent for subsequent Codex credential requests', async () => {
    const workspace = new ExecutorWorkspace({ workingDir: root });
    const gate = new ExecutorGate(workspace, 'full', Date.now, { confirmCredentials: true });
    const confirm = vi.fn(async () => 'session' as const);
    const executor = new RemoteExecutor({ workspace, gate, rgPath: 'unused', confirm });
    const relay = new ExecServerRelay({
      codexPath: 'codex', cwd: root, workspace,
      authorize: (action) => executor.check(action),
      confirm: (action) => executor.confirm(action),
      push: async () => undefined,
    });
    try {
      relay.handle({ t: 'ws', connId: 'credentials', kind: 'open', path: '/ws/exec-server' });
      for (const [id, file] of [[1, '.env'], [2, '.env.production']] as const) {
        relay.handle({
          t: 'ws', connId: 'credentials', kind: 'message',
          data: JSON.stringify({ id, method: 'fs/readFile', params: { path: path.join(root, file) } }),
        });
      }
      await vi.waitFor(() => expect(spawned.lines.map((line) => JSON.parse(line).id)).toEqual([1, 2]));
      expect(confirm).toHaveBeenCalledTimes(1);
    } finally {
      relay.close();
      await executor.close();
    }
  });
  it('passes ordinary messages straight through', () => {
    const { send, sentIds, pending } = setup();
    send({ id: 1, method: 'fs/readFile', params: { path: path.join(root, 'a.txt') } });
    send({ method: 'initialized', params: {} });
    expect(sentIds()).toEqual([1, undefined]);
    expect(pending).toEqual([]);
  });

  it.each(['fs/writeFile', 'fs/open'])('does not read old content while %s is awaiting consent or after it is denied', async (method) => {
    const target = path.join(root, 'denied.txt');
    fs.writeFileSync(target, 'old content');
    const { relay, send, pending, replies, sentIds } = setup(() => ({ ok: false, reason: 'write denied' }));
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      send({ id: 1, method, params: { path: target, mode: 'replace', dataBase64: Buffer.from('new content').toString('base64') } });
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      expect(read).not.toHaveBeenCalledWith(target);
      pending[0].answer(false);
      await vi.waitFor(() => expect(replies).toEqual([{ id: 1, error: { code: -32001, message: 'write denied' } }]));
      expect(read).not.toHaveBeenCalledWith(target);
      expect(sentIds()).toEqual([]);
    } finally {
      read.mockRestore();
      relay.close();
    }
  });

  it('reads old content only after the earlier confirmation has released the queued write', async () => {
    const target = path.join(root, 'queued.txt');
    fs.writeFileSync(target, 'old content');
    const { relay, send, pending, sentIds } = setup();
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      send({ id: 1, method: 'fs/readFile', params: { path: path.join(root, '.env') } });
      send({ id: 2, method: 'fs/writeFile', params: { path: target, dataBase64: Buffer.from('new content').toString('base64') } });
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      expect(read).not.toHaveBeenCalledWith(target);
      pending[0].answer(true);
      await vi.waitFor(() => expect(sentIds()).toEqual([1, 2]));
      expect(read).toHaveBeenCalledWith(target);
    } finally {
      read.mockRestore();
      relay.close();
    }
  });

  it('checks fs/open replace as a write before allowing the handle stream', async () => {
    const { send, pending, replies } = setup();
    send({ id: 1, method: 'fs/open', params: { handleId: 'h1', mode: 'replace', path: path.join(root, '.env') } });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(pending[0].action).toEqual({ kind: 'write', path: path.join(root, '.env') });
    pending[0].answer(false);
    await vi.waitFor(() => expect(replies).toEqual([{ id: 1, error: { code: -32001, message: 'needs confirmation' } }]));
  });

  it.each(['supplied', 'returned'])('keeps original path spellings for a %s write handle after open truncates the file', async (handleSource) => {
    const actual = path.join(root, 'project');
    const virtual = '/Users/agent/workspace';
    fs.mkdirSync(actual, { recursive: true });
    const target = path.join(actual, 'notes.json');
    const original = JSON.stringify({ out: path.join(actual, 'out.txt') });
    fs.writeFileSync(target, original);
    const workspace = new ExecutorWorkspace({ workingDir: actual, aliases: [{ from: virtual, to: actual }] });
    workspace.setVirtualRoot(virtual);
    const { relay, send, sentIds } = setup(undefined, workspace);
    try {
      send({ id: 1, method: 'fs/open', params: { mode: 'replace', path: virtual + '/notes.json',
        ...(handleSource === 'supplied' ? { handleId: 'write-handle' } : {}) } });
      await vi.waitFor(() => expect(sentIds()).toEqual([1]));
      fs.writeFileSync(target, '');
      spawned.children[0].stdout.write(JSON.stringify({ id: 1, result: handleSource === 'returned' ? { handleId: 'write-handle' } : {} }) + '\n');
      send({ id: 2, method: 'fs/writeBlock', params: { handleId: 'write-handle',
        dataBase64: Buffer.from(JSON.stringify({ out: virtual + '/out.txt' })).toString('base64') } });
      await vi.waitFor(() => expect(sentIds()).toEqual([1, 2]));
      const forwarded = JSON.parse(spawned.lines[1]) as { params: { dataBase64: string } };
      expect(Buffer.from(forwarded.params.dataBase64, 'base64').toString('utf8')).toBe(original);
    } finally {
      relay.close();
    }
  });

  it('does not pre-read credentials or read-only opens, even after authorization', () => {
    const secret = path.join(root, '.env');
    const ordinary = path.join(root, 'notes.txt');
    fs.writeFileSync(secret, 'FAKE_TEST_VALUE=unused');
    fs.writeFileSync(ordinary, 'ordinary content');
    const { relay, send, sentIds } = setup(() => ({ ok: true }));
    const read = vi.spyOn(fs, 'readFileSync');
    try {
      send({ id: 1, method: 'fs/open', params: { path: secret, mode: 'replace', handleId: 'secret' } });
      send({ id: 2, method: 'fs/open', params: { path: ordinary, mode: 'read', handleId: 'read' } });
      expect(sentIds()).toEqual([1, 2]);
      expect(read).not.toHaveBeenCalledWith(secret);
      expect(read).not.toHaveBeenCalledWith(ordinary);
    } finally {
      read.mockRestore();
      relay.close();
    }
  });

  it.each(['closed', 'failed'])('releases a %s handle before it can restore stale file content', (ending) => {
    const actual = path.join(root, 'project');
    const virtual = '/Users/agent/workspace';
    fs.mkdirSync(actual, { recursive: true });
    fs.writeFileSync(path.join(actual, 'notes.json'), JSON.stringify({ out: path.join(actual, 'out.txt') }));
    const workspace = new ExecutorWorkspace({ workingDir: actual, aliases: [{ from: virtual, to: actual }] });
    workspace.setVirtualRoot(virtual);
    const { relay, send } = setup(undefined, workspace);
    try {
      send({ id: 1, method: 'fs/open', params: { path: virtual + '/notes.json', mode: 'replace', fd: 7 } });
      spawned.children[0].stdout.write(JSON.stringify(ending === 'failed'
        ? { id: 1, error: { code: -1, message: 'open failed' } } : { id: 1, result: {} }) + '\n');
      if (ending === 'closed') {
        send({ id: 2, method: 'fs/close', params: { fd: 7 } });
        spawned.children[0].stdout.write(JSON.stringify({ id: 2, result: {} }) + '\n');
      }
      const data = Buffer.from(JSON.stringify({ out: virtual + '/out.txt' }));
      send({ id: 3, method: 'fs/writeBlock', params: { fd: 7, dataBase64: data.toString('base64') } });
      const forwarded = JSON.parse(spawned.lines.at(-1)!) as { params: { dataBase64: string } };
      expect(Buffer.from(forwarded.params.dataBase64, 'base64')).toEqual(workspace.mapInputFromAgent(data));
    } finally {
      relay.close();
    }
  });

  it('keeps later messages behind one that waits for the user, then forwards them in order', async () => {
    const { send, sentIds, pending } = setup();
    send({ id: 1, method: 'fs/readFile', params: { path: path.join(root, '.env') } });
    send({ id: 2, method: 'fs/readFile', params: { path: path.join(root, 'a.txt') } });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(sentIds()).toEqual([]);
    pending[0].answer(true);
    await vi.waitFor(() => expect(sentIds()).toEqual([1, 2]));
  });

  it('answers with an error when the user declines and carries on with the rest', async () => {
    const { send, sentIds, pending, replies } = setup();
    send({ id: 1, method: 'fs/readFile', params: { path: path.join(root, '.env') } });
    send({ id: 2, method: 'fs/readFile', params: { path: path.join(root, 'a.txt') } });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    pending[0].answer(false);
    await vi.waitFor(() => expect(sentIds()).toEqual([2]));
    expect(replies).toEqual([{ id: 1, error: { code: -32001, message: 'needs confirmation' } }]);
  });

  it('drops what is still waiting when the connection closes', async () => {
    const { relay, send, sentIds, pending } = setup();
    send({ id: 1, method: 'fs/readFile', params: { path: path.join(root, '.env') } });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    relay.handle({ t: 'ws', connId: 'c1', kind: 'close' });
    pending[0].answer(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sentIds()).toEqual([]);
  });
});

describe('exec-server relay summary (#5764)', () => {
  function relayWith(opts: { allow: boolean; pushMs: number }) {
    let clock = 0;
    const warn = vi.fn();
    const relay = new ExecServerRelay({
      codexPath: 'codex',
      cwd: root,
      workspace: new ExecutorWorkspace({ workingDir: root }),
      authorize: (): ExecutorGateDecision => (opts.allow ? { ok: true } : { ok: false, reason: 'outside the workspace' }),
      push: async () => {
        clock += opts.pushMs;
      },
      now: () => clock,
      log: { warn },
    });
    relay.handle({ t: 'ws', connId: 'c1', kind: 'open', path: '/ws/exec-server' });
    const send = (message: Record<string, unknown>) =>
      relay.handle({ t: 'ws', connId: 'c1', kind: 'message', data: JSON.stringify(message) });
    return { relay, warn, send };
  }

  it('logs the first slow push right away and a summary with refusals when the task ends', async () => {
    const { relay, warn, send } = relayWith({ allow: false, pushMs: 2_500 });
    send({ id: 1, method: 'fs/walk', params: { path: path.join(root, '..', 'skills') } });
    await vi.waitFor(() => expect(relay.stats().pushes).toBe(1));
    expect(warn).toHaveBeenCalledWith('remote agent: exec-server push slow', { pushMs: 2_500, frames: 1 });
    relay.close();
    expect(relay.stats()).toEqual({ requests: 1, rejected: 1, pushes: 1, pushMaxMs: 2_500, pushAvgMs: 2_500, slowPushes: 1 });
    expect(warn).toHaveBeenLastCalledWith('remote agent: exec-server relay summary', relay.stats());
  });

  it('stays quiet when the link was fast and nothing was refused', () => {
    const { relay, warn, send } = relayWith({ allow: true, pushMs: 10 });
    send({ id: 1, method: 'fs/readFile', params: { path: path.join(root, 'a.txt') } });
    relay.close();
    expect(relay.stats()).toMatchObject({ requests: 1, rejected: 0, slowPushes: 0 });
    expect(warn).not.toHaveBeenCalled();
  });
});
