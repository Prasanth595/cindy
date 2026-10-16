import { describe, expect, it } from 'vitest';
import { UI_ACTION_TRIGGER_PREFIX } from '../../../shared/interruptedTurn.js';
import { createCompanionMirror, mirrorMessageText, splitMirrorText, type CompanionMirrorCursor, type CompanionMirrorRow } from '../mirror.js';
import { fakeApi, memoryState, rejection } from './fakes.js';

const ROOM = '10000000-0000-4000-8000-000000000001';
let nextId = 0;
const row = (role: string, content: unknown, extra: Partial<CompanionMirrorRow> = {}): CompanionMirrorRow => {
  nextId += 1;
  return { id: `m${String(nextId).padStart(5, '0')}`, clientId: `c${nextId}`, role, agentMeta: null, createdAt: 1_000 + nextId,
    content: typeof content === 'string' ? content : JSON.stringify(content), ...extra };
};
const user = (text: string, extra?: Partial<CompanionMirrorRow>) => row('user', { text, images: [], files: [] }, extra);
const reply = (text: string, extra?: Partial<CompanionMirrorRow>) => row('assistant', [{ type: 'text', text }], extra);

describe('mirrorMessageText', () => {
  it('keeps visible user text with attachment placeholders and assistant replies', () => {
    expect(mirrorMessageText(row('user', { text: 'look', images: [{ url: 'x', originalName: 'cat.png' }], files: [{ name: 'a.pdf', path: '/a.pdf' }] })))
      .toBe('look\n[附件: cat.png]\n[附件: a.pdf]');
    expect(mirrorMessageText(reply('hello'))).toBe('hello');
  });
  it('keeps an attachment-only message as placeholders, but not one from another source', () => {
    expect(mirrorMessageText(row('user', { text: '', images: [{ url: 'x', originalName: 'cat.png' }], files: [] }))).toBe('[附件: cat.png]');
    expect(mirrorMessageText(row('user', { text: '', images: [{ url: 'x' }], files: [] },
      { agentMeta: JSON.stringify({ imSource: { channel: 'feishu' } }) }))).toBeNull();
  });
  it.each([
    ['tool rows', row('tool_use', { name: 'Bash' })],
    ['thinking rows', row('thinking', 'hmm')],
    ['hidden synthetic input', row('user', `${UI_ACTION_TRIGGER_PREFIX}continue`)],
    ['messages that came from the room', user('hi', { clientId: 'chat-direct:exec-1' })],
    ['imported cloud history', reply('old', { clientId: 'cloud-history:abc' })],
    ['empty text', reply('   ')],
    ['private coordination replies', reply('internal', { agentMeta: JSON.stringify({ botPrivateReply: true }) })],
    ['progress commentary', reply('checking files', { agentMeta: JSON.stringify({ assistantPhase: 'commentary' }) })],
    ['sub-agent output', reply('sub result', { agentMeta: JSON.stringify({ parentToolUseId: 'toolu_1' }) })],
    ['sub-agent output (snake case)', reply('sub result', { agentMeta: JSON.stringify({ parent_tool_use_id: 'toolu_1' }) })],
    ['Claude sub-agent output (parentUuid)', reply('sub result', { agentMeta: JSON.stringify({ parentUuid: 'toolu_subagent' }) })],
    ['input sent by another task or teammate', user('do this', { agentMeta: JSON.stringify({ origin: { kind: 'session', senderSessionId: 's' } }) })],
    ['input from an automation', user('scheduled', { agentMeta: JSON.stringify({ origin: { kind: 'scheduler', scheduleId: 'r' } }) })],
    ['input from a plugin', user('plugin says', { agentMeta: JSON.stringify({ sourcePlugin: { pluginId: 'p' } }) })],
    ['input from an IM channel', user('from feishu', { agentMeta: JSON.stringify({ imSource: { channel: 'feishu' } }) })],
    ['input from a shared-task member', user('guest', { agentMeta: JSON.stringify({ sharedTaskAuthor: { memberId: 'm' } }) })],
    ['a group-sourced message', user('group', { agentMeta: JSON.stringify({ sourceGroup: { groupId: 'g' } }) })],
  ])('drops %s', (_name, value) => {
    expect(mirrorMessageText(value)).toBeNull();
  });
});

describe('owner-typed input', () => {
  it('keeps what the owner typed on another device', () => {
    expect(mirrorMessageText(user('from my phone', { agentMeta: JSON.stringify({ sourceDevice: { deviceId: 'phone', platform: 'mobile' } }) })))
      .toBe('from my phone');
  });
});

describe('splitMirrorText', () => {
  it('splits long and multibyte text into room-sized parts', () => {
    const ascii = splitMirrorText('a'.repeat(65_000));
    expect(ascii.map(part => part.length)).toEqual([30_000, 30_000, 5_000]);
    const cjk = splitMirrorText('字'.repeat(30_000));
    expect(cjk.join('')).toBe('字'.repeat(30_000));
    expect(cjk.every(part => Buffer.byteLength(JSON.stringify(part)) <= 60_000)).toBe(true);
    const emoji = splitMirrorText('😀'.repeat(20_000));
    expect(emoji.join('')).toBe('😀'.repeat(20_000));
    expect(emoji.every(part => !/[\uD800-\uDBFF]$/.test(part))).toBe(true);
  });
});

function setup(rows: CompanionMirrorRow[], failImport?: (call: number) => boolean) {
  let imports = 0;
  const { api, calls } = fakeApi((route, method) => {
    if (route === '/conversations' && method === 'POST') return { id: ROOM };
    if (route.endsWith('/import')) {
      imports += 1;
      if (failImport?.(imports)) throw rejection(503, 'UNAVAILABLE');
      return { messages: [] };
    }
    throw new Error(`unexpected ${route}`);
  });
  const { state } = memoryState();
  const after = (cursor: CompanionMirrorCursor) => (r: CompanionMirrorRow) =>
    r.createdAt > cursor.createdAt || (r.createdAt === cursor.createdAt && r.id > cursor.id);
  const mirror = createCompanionMirror({
    api, state, humanActorId: () => 'human',
    canonicalSession: async () => 'session-1',
    rowsAfter: async (_sessionId, cursor, limit) => rows.filter(after(cursor))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(0, limit),
    latestRows: async (_sessionId, limit) => [...rows].reverse().slice(0, limit),
  });
  const imported = () => calls.filter(call => call.route.endsWith('/import'))
    .map(call => (call.data as { messages: Array<{ sourceId: string; authorId: string; content: Array<{ text: string }> }> }).messages);
  return { mirror, state, calls, imported, rows };
}

describe('companion conversation mirror', () => {
  it('creates the deterministic room once and imports authored messages in order', async () => {
    const rows = [user('hi'), row('tool_use', {}), reply('hello')];
    const t = setup(rows);
    await t.mirror.syncBot('bot', 'actor', 'Mia');
    expect(t.calls[0]).toMatchObject({ route: '/conversations', method: 'POST',
      data: { operationId: 'companion-room:actor', kind: 'direct', name: 'Mia', participants: ['actor'], sourceId: 'actor' } });
    expect(t.imported()).toEqual([[
      expect.objectContaining({ sourceId: `cindy:session-1:${rows[0]!.id}`, authorId: 'human', content: [{ type: 'text', text: 'hi' }],
        createdAt: new Date(rows[0]!.createdAt).toISOString() }),
      expect.objectContaining({ sourceId: `cindy:session-1:${rows[2]!.id}`, authorId: 'actor', content: [{ type: 'text', text: 'hello' }] }),
    ]]);
    expect(t.state.bot('bot')).toMatchObject({ roomId: ROOM, mirror: { sessionId: 'session-1', id: rows[2]!.id } });
    rows.push(user('again'));
    await t.mirror.syncBot('bot', 'actor', 'Mia');
    expect(t.calls.filter(call => call.route === '/conversations')).toHaveLength(1);
    expect(t.imported()[1]!.map(m => m.content[0]!.text)).toEqual(['again']);
  });

  it('backfills only the latest 200 eligible messages on the first run', async () => {
    const rows = Array.from({ length: 260 }, (_, i) => (i % 2 ? reply(`r${i}`) : user(`u${i}`)));
    const t = setup(rows);
    await t.mirror.syncBot('bot', 'actor', 'Mia');
    const batches = t.imported();
    expect(batches.map(batch => batch.length)).toEqual([50, 50, 50, 50]);
    expect(batches.flat()[0]!.content[0]!.text).toBe('u60');
    expect(batches.flat().at(-1)!.content[0]!.text).toBe('r259');
  });

  it('advances the cursor only past successfully imported batches', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => user(`u${i}`));
    const t = setup([], call => call === 2);
    // Start from an existing cursor so the rows are read incrementally.
    t.state.update('bot', 'actor', entry => { entry.mirror = { sessionId: 'session-1', createdAt: 0, id: '' }; });
    t.rows.push(...rows);
    await expect(t.mirror.syncBot('bot', 'actor', 'Mia')).rejects.toThrow('UNAVAILABLE');
    expect(t.state.bot('bot')?.mirror?.id).toBe(rows[49]!.id);
    await t.mirror.syncBot('bot', 'actor', 'Mia');
    const texts = t.imported().map(batch => batch.map(m => m.content[0]!.text));
    expect(texts[2]![0]).toBe('u50');
    expect(t.state.bot('bot')?.mirror?.id).toBe(rows[119]!.id);
  });

  it('caps an ordinary pass at ten pages, but drains the whole backlog before a hand-over', async () => {
    const t = setup([]);
    t.state.update('bot', 'actor', entry => { entry.mirror = { sessionId: 'session-1', createdAt: 0, id: '' }; });
    t.rows.push(...Array.from({ length: 2_300 }, (_, i) => user(`u${i}`)));
    const last = t.rows.at(-1)!.id;
    await t.mirror.syncBot('bot', 'actor', 'Mia');
    expect(t.state.bot('bot')?.mirror?.id).not.toBe(last);
    await t.mirror.syncBot('bot', 'actor', 'Mia', { drain: true });
    expect(t.state.bot('bot')?.mirror?.id).toBe(last);
  });

  it('splits a long reply into parts with stable source ids', async () => {
    const long = reply('y'.repeat(31_000));
    const t = setup([long]);
    await t.mirror.syncBot('bot', 'actor', 'Mia');
    expect(t.imported()[0]!.map(m => m.sourceId)).toEqual([`cindy:session-1:${long.id}`, `cindy:session-1:${long.id}:p1`]);
  });

  it('does nothing without a canonical Session', async () => {
    const { api, calls } = fakeApi(() => ({}));
    const mirror = createCompanionMirror({ api, state: memoryState().state, humanActorId: () => 'human',
      canonicalSession: async () => null, rowsAfter: async () => [], latestRows: async () => [] });
    await mirror.syncBot('bot', 'actor', 'Mia');
    expect(calls).toEqual([]);
  });
});

describe('cursor safety', () => {
  it('re-scans a trailing window for rows persisted late, without re-sending recent imports', async () => {
    const rows = [user('one'), reply('two')];
    const t = setup(rows);
    await t.mirror.syncBot('bot', 'actor', 'Mia');
    expect(t.imported()).toHaveLength(1);
    // An assistant reply stamped before the cursor but persisted after the last pass.
    const late = reply('late reply', { createdAt: rows[1]!.createdAt - 1 });
    t.rows.push(late);
    t.rows.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    await t.mirror.syncBot('bot', 'actor', 'Mia');
    expect(t.imported()[1]!.map(m => m.content[0]!.text)).toEqual(['late reply']);
    await t.mirror.syncBot('bot', 'actor', 'Mia');
    expect(t.imported()).toHaveLength(2);
  });

  it('never lets imported history move the cursor forward', async () => {
    const own = user('mine');
    const t = setup([own]);
    await t.mirror.syncBot('bot', 'actor', 'Mia');
    // A row brought in by take-over, stamped by a peer clock far in the future.
    t.rows.push(reply('from peer', { clientId: 'cloud-history:x', createdAt: own.createdAt + 86_400_000 }));
    await t.mirror.syncBot('bot', 'actor', 'Mia');
    expect(t.state.bot('bot')?.mirror?.id).toBe(own.id);
    const next = user('typed after');
    t.rows.push(next);
    await t.mirror.syncBot('bot', 'actor', 'Mia');
    expect(t.imported().at(-1)!.map(m => m.content[0]!.text)).toEqual(['typed after']);
  });
});
