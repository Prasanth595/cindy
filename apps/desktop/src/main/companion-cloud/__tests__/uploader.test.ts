import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, createCompanionUploader, type CompanionPreferenceValue } from '../uploader.js';
import { fakeApi, memoryState, rejection } from './fakes.js';

const profile = (soul: string): CompanionPreferenceValue =>
  ({ key: 'companion.profile.v1', value: { name: 'Mia', description: '', soul, systemPrompt: '', user: '' } });
const memory = (filename: string, content: string): CompanionPreferenceValue =>
  ({ key: `companion.memory.v1:${filename}`, value: { filename, content } });

function setup(server: Array<{ key: string; value: unknown; revision: number }> = []) {
  const revisions = new Map(server.map(row => [row.key, row.revision]));
  const { api, calls } = fakeApi((route, method, data) => {
    if (route === '/preferences' && method === 'GET') return server;
    const body = data as { key: string; expectedRevision: number };
    const current = revisions.get(body.key) ?? 0;
    if (current !== body.expectedRevision) throw rejection(409, 'REVISION_CONFLICT', { revision: current });
    revisions.set(body.key, current + 1);
    return { revision: current + 1 };
  });
  const { state } = memoryState();
  let values: CompanionPreferenceValue[] = [];
  const log = { warn: vi.fn() };
  const uploader = createCompanionUploader({ api, state, readValues: async () => values, log, maxValueBytes: 2000 });
  const writes = () => calls.filter(call => call.method === 'POST').map(call => call.data as { key: string; value: unknown; expectedRevision: number });
  return { uploader, state, calls, writes, log, setValues: (next: CompanionPreferenceValue[]) => { values = next; } };
}

describe('companion profile uploader', () => {
  it('uploads only changed values, as the companion actor', async () => {
    const t = setup();
    t.setValues([profile('soul v1'), memory('a.md', 'alpha')]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().map(w => [w.key, w.expectedRevision])).toEqual([['companion.profile.v1', 0], ['companion.memory.v1:a.md', 0]]);
    expect(t.calls.every(call => call.actorId === 'actor')).toBe(true);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes()).toHaveLength(2);
    t.setValues([profile('soul v2'), memory('a.md', 'alpha')]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().slice(2).map(w => [w.key, w.expectedRevision])).toEqual([['companion.profile.v1', 1]]);
    expect(t.state.bot('bot')?.prefs['companion.profile.v1']?.revision).toBe(2);
  });

  it('writes a null tombstone once for a value that disappeared locally', async () => {
    const t = setup();
    t.setValues([profile('soul'), memory('a.md', 'alpha')]);
    await t.uploader.syncBot('bot', 'actor');
    t.setValues([profile('soul')]);
    await t.uploader.syncBot('bot', 'actor');
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().slice(2)).toEqual([expect.objectContaining({ key: 'companion.memory.v1:a.md', value: null, expectedRevision: 1 })]);
  });

  it('seeds revisions from the server, retries a conflict once and tombstones stale server keys', async () => {
    const t = setup([
      { key: 'companion.profile.v1', value: profile('soul').value, revision: 4 },
      { key: 'companion.memory.v1:gone.md', value: { filename: 'gone.md', content: 'x' }, revision: 2 },
      { key: 'other.app.key', value: 1, revision: 9 },
    ]);
    t.setValues([profile('soul'), memory('new.md', 'n')]);
    await t.uploader.syncBot('bot', 'actor');
    // The unchanged profile is recognised regardless of key order on the server.
    expect(t.writes().map(w => [w.key, w.value === null ? null : 'value', w.expectedRevision])).toEqual([
      ['companion.memory.v1:new.md', 'value', 0],
      ['companion.memory.v1:gone.md', null, 2],
    ]);
    // A stale local revision (another writer) is retried with the server's revision.
    t.state.update('bot', 'actor', entry => { entry.prefs['companion.memory.v1:new.md'] = { hash: 'old', revision: 0 }; });
    t.setValues([profile('soul'), memory('new.md', 'changed')]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().slice(2).map(w => w.expectedRevision)).toEqual([0, 1]);
    expect(t.state.bot('bot')?.prefs['companion.memory.v1:new.md']?.revision).toBe(2);
  });

  it('skips oversized values without truncating and keeps going', async () => {
    const t = setup();
    t.setValues([memory('big.md', 'x'.repeat(5000)), memory('small.md', 's')]);
    await t.uploader.syncBot('bot', 'actor');
    expect(t.writes().map(w => w.key)).toEqual(['companion.memory.v1:small.md']);
    expect(t.log.warn).toHaveBeenCalledWith('Companion value too large to upload; skipped', expect.objectContaining({ keyKind: 'companion.memory.v1' }));
  });

  it('logs and retries later when the server keeps failing', async () => {
    const { api } = fakeApi(() => { throw rejection(503, 'UNAVAILABLE'); });
    const log = { warn: vi.fn() };
    const uploader = createCompanionUploader({ api, state: memoryState().state, readValues: async () => [profile('s')], log });
    await uploader.syncAll([{ botId: 'bot', actorId: 'actor' }]);
    expect(log.warn).toHaveBeenCalledWith('Companion upload will retry', { actorId: 'actor', code: 'UNAVAILABLE' });
  });

  it('serialises JSON with sorted keys', () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: 'x' }], e: undefined })).toBe('{"a":[{"c":"x","d":null}],"b":1}');
  });
});
