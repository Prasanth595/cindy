import { describe, expect, it, vi } from 'vitest';
import { materializeCompanion } from '../materialize.js';
import { valueHash } from '../uploader.js';
import { fakeApi, fakeLocal, memoryState } from './fakes.js';

const ROOM = '10000000-0000-4000-8000-000000000001';
const actor = { id: 'actor-1', externalId: 'bot_mia', name: 'Mia', avatar: '🦊' };
const iso = (ms: number) => new Date(ms).toISOString();

const roomMessage = (id: string, seq: number, authorId: string, text: string, createdAt: number) =>
  ({ id, seq: String(seq), authorId, origin: 'chat', deleted: false, threadRootId: null, createdAt: iso(createdAt), content: [{ type: 'text', text }] });

function cloud(prefs: Array<{ key: string; value: unknown }>, room: unknown[] = []) {
  return fakeApi((route, method) => {
    if (route === '/preferences' && method === 'GET') return prefs.map((p, i) => ({ ...p, revision: i + 1 }));
    if (route.startsWith(`/conversations/${ROOM}/messages?`)) return room;
    throw new Error(`unexpected ${method} ${route}`);
  });
}

const profilePref = { key: 'companion.profile.v1', value: { name: 'Mia', description: 'helper', soul: 'I am Mia', systemPrompt: 'custom', user: 'Owner likes tea' } };

describe('materializeCompanion', () => {
  it('creates a missing companion from its cloud profile, memories and skills', async () => {
    const { api, calls } = cloud([profilePref,
      { key: 'companion.memory.v1:user_tea.md', value: { filename: 'user_tea.md', content: '---\ntitle: Tea\n---\nlikes tea' } },
      { key: 'companion.skill.v1:brew', value: { slug: 'brew', content: '---\nname: brew\n---\n\nsteps' } }]);
    const local = fakeLocal();
    const { state } = memoryState();
    state.update('bot_mia', 'actor-1', entry => { entry.demoted = true; });
    const result = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
    expect(calls[0]).toMatchObject({ route: '/preferences', method: 'GET', actorId: 'actor-1' });
    expect(local.host.createProfile).toHaveBeenCalledWith({ id: 'bot_mia', name: 'Mia', description: 'helper',
      identitySource: 'I am Mia', userContextSource: 'Owner likes tea', avatar: '🦊' }, expect.anything());
    expect(local.host.updateProfile).not.toHaveBeenCalled();
    expect(local.host.writeSystemPrompt).toHaveBeenCalledWith('bot_mia', 'custom', expect.anything());
    expect(local.memories.get('user_tea.md')).toContain('likes tea');
    expect(local.skills.get('brew')).toContain('steps');
    expect(result).toEqual({ created: true, inserted: 0, rebuild: 'skipped', failures: 0 });
    expect(state.bot('bot_mia')?.demoted).toBeUndefined();
    expect(local.host.rebuildContext).not.toHaveBeenCalled();
  });

  it('updates an existing companion; a tombstone deletes only what this device last had, unchanged', async () => {
    const { api } = cloud([profilePref,
      { key: 'companion.memory.v1:user_old.md', value: null },
      { key: 'companion.memory.v1:user_edited.md', value: null },
      { key: 'companion.memory.v1:user_never.md', value: null },
      { key: 'companion.memory.v1:user_same.md', value: { filename: 'user_same.md', content: 'same' } },
      { key: 'companion.skill.v1:gone', value: null }]);
    const local = fakeLocal();
    local.setProfile({ status: 'paused', displayName: 'Old', description: '' });
    local.memories.set('user_old.md', 'old'); local.memories.set('user_edited.md', 'edited here');
    local.memories.set('user_never.md', 'only here'); local.memories.set('user_same.md', 'same');
    local.skills.set('gone', 'x');
    const { state } = memoryState();
    state.update('bot_mia', 'actor-1', entry => {
      entry.prefs['companion.memory.v1:user_old.md'] = { hash: valueHash({ filename: 'user_old.md', content: 'old' }), revision: 1, local: true };
      entry.prefs['companion.memory.v1:user_edited.md'] = { hash: valueHash({ filename: 'user_edited.md', content: 'original' }), revision: 1, local: true };
    });
    const result = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
    expect(local.host.createProfile).not.toHaveBeenCalled();
    expect(local.host.updateProfile).toHaveBeenCalledWith({ id: 'bot_mia', name: 'Mia', description: 'helper', identitySource: 'I am Mia', userContextSource: 'Owner likes tea' }, expect.anything());
    expect(vi.mocked(local.host.removeMemory).mock.calls.map(call => call[1])).toEqual(['user_old.md']);
    expect([...local.memories.keys()].sort()).toEqual(['user_edited.md', 'user_never.md', 'user_same.md']);
    expect(local.host.restoreMemory).not.toHaveBeenCalled();
    // The skill was never synced from here: kept.
    expect(local.host.removeSkill).not.toHaveBeenCalled();
    // This device had synced before: no backup.
    expect(result.backup).toBeUndefined();
    expect(state.bot('bot_mia')?.prefs['companion.memory.v1:user_same.md']).toMatchObject({ local: true });
  });

  it('backs up a local copy that never synced before overwriting it', async () => {
    const { api } = cloud([profilePref]);
    const local = fakeLocal({ backupHome: vi.fn(async () => '/backups/bot_mia-1') });
    local.setProfile({ status: 'active', displayName: 'Cindy', description: '' });
    const log = { warn: vi.fn(), info: vi.fn() };
    const result = await materializeCompanion({ api, state: memoryState().state, host: local.host, actor, roomId: async () => ROOM, log });
    expect(result.backup).toBe('/backups/bot_mia-1');
    expect(local.host.backupHome).toHaveBeenCalledBefore(local.host.updateProfile as never);
    expect(log.info).toHaveBeenCalledWith('Companion local copy backed up before take-over', { actorId: 'actor-1', backup: '/backups/bot_mia-1' });
  });

  it('stops at the first step after the account changed', async () => {
    const { api } = cloud([profilePref, { key: 'companion.memory.v1:user_tea.md', value: { filename: 'user_tea.md', content: 'tea' } }],
      [roomMessage('m1', 1, 'human', 'hello', 1_700_000_000_000)]);
    let current = true;
    const local = fakeLocal({ createProfile: vi.fn(async () => { current = false; }) });
    await expect(materializeCompanion({ api, state: memoryState().state, host: local.host, actor, roomId: async () => ROOM,
      fence: { assertCurrent: () => { if (!current) throw new Error('OWNER_CHANGED'); } } })).rejects.toThrow('OWNER_CHANGED');
    expect(local.host.restoreMemory).not.toHaveBeenCalled();
    expect(local.host.writeSystemPrompt).not.toHaveBeenCalled();
    expect(local.host.insertHistory).not.toHaveBeenCalled();
    expect(local.host.rebuildContext).not.toHaveBeenCalled();
  });

  it('does not bring back a message that was rewound or deleted here', async () => {
    const at = 1_700_000_000_000;
    const { api } = cloud([profilePref], [roomMessage('m1', 1, 'human', 'regretted', at)]);
    const local = fakeLocal({ localMessageTimes: vi.fn(async () => [{ role: 'message_tombstone', createdAt: at, clientId: 'c1', removed: true }]) });
    local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    const result = await materializeCompanion({ api, state: memoryState().state, host: local.host, actor, roomId: async () => ROOM });
    expect(result.inserted).toBe(0);
  });

  it('inserts the room history that is not local yet, then rebuilds the context once', async () => {
    const mirroredAt = 1_700_000_000_000;
    const room = [
      roomMessage('m3', 3, 'actor-1', 'reply from laptop', mirroredAt + 2000),
      roomMessage('m2', 2, 'human', 'question on laptop', mirroredAt + 1000),
      roomMessage('m1', 1, 'human', 'mirrored from here', mirroredAt),
    ];
    const { api } = cloud([profilePref], room);
    const local = fakeLocal();
    local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    local.rows.push({ id: 'own', clientId: 'c-own', role: 'user', content: 'mirrored from here', agentMeta: null, createdAt: mirroredAt });
    const { state } = memoryState();
    const result = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
    expect(vi.mocked(local.host.insertHistory).mock.calls.map(call => call[1])).toEqual([
      { clientId: 'cloud-history:m2', role: 'user', text: 'question on laptop', createdAt: mirroredAt + 1000 },
      { clientId: 'cloud-history:m3', role: 'assistant', text: 'reply from laptop', createdAt: mirroredAt + 2000 },
    ]);
    expect(result).toMatchObject({ inserted: 2, rebuild: 'rebuilt' });
    expect(local.host.rebuildContext).toHaveBeenCalledOnce();
    // Imported history never moves the mirror cursor: it stays on the newest row written here.
    expect(state.bot('bot_mia')).toMatchObject({ mirror: { sessionId: 'session-1', createdAt: mirroredAt, id: 'own' } });
    expect(state.bot('bot_mia')?.pendingRebuild).toBeUndefined();
    // A second run finds everything local and does not rebuild again.
    const again = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
    expect(again).toMatchObject({ inserted: 0, rebuild: 'skipped' });
    expect(local.host.rebuildContext).toHaveBeenCalledOnce();
  });

  it('does not re-insert a room message that was already delivered here as a direct-room input', async () => {
    const room = [roomMessage('m9', 9, 'human', 'from the phone', 1_700_000_000_000)];
    const { api } = cloud([profilePref], room);
    const local = fakeLocal();
    local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    // Delivered later than the room message was written, under its own client id.
    local.rows.push({ id: 'd', clientId: 'chat-direct:exec-1:m9', role: 'user', content: 'from the phone', agentMeta: null, createdAt: 1_700_000_005_000 });
    const result = await materializeCompanion({ api, state: memoryState().state, host: local.host, actor, roomId: async () => ROOM });
    expect(result.inserted).toBe(0);
    expect(local.host.insertHistory).not.toHaveBeenCalled();
  });

  it('defers the rebuild while the Session is busy', async () => {
    const { api } = cloud([profilePref], [roomMessage('m1', 1, 'human', 'hello', 1_700_000_000_000)]);
    const local = fakeLocal({ rebuildContext: vi.fn(async () => 'busy' as const) });
    local.setProfile({ status: 'active', displayName: 'Mia', description: '' });
    const { state } = memoryState();
    const result = await materializeCompanion({ api, state, host: local.host, actor, roomId: async () => ROOM });
    expect(result.rebuild).toBe('busy');
    expect(state.bot('bot_mia')?.pendingRebuild).toBe(true);
  });

  it('keeps going when one memory cannot be restored', async () => {
    const { api } = cloud([profilePref, { key: 'companion.memory.v1:user_bad.md', value: { filename: 'user_bad.md', content: 'x' } }]);
    const local = fakeLocal({ restoreMemory: vi.fn(async () => { throw new Error('INVALID'); }) });
    const log = { warn: vi.fn() };
    const result = await materializeCompanion({ api, state: memoryState().state, host: local.host, actor, roomId: async () => ROOM, log });
    expect(result.failures).toBe(1);
    expect(log.warn).toHaveBeenCalledWith('Companion content could not be restored', { actorId: 'actor-1', kind: 'memory', code: 'INVALID' });
  });

  it('refuses a profile that is being deleted', async () => {
    const { api } = cloud([profilePref]);
    const local = fakeLocal();
    local.setProfile({ status: 'deleting', displayName: 'Mia', description: '' });
    await expect(materializeCompanion({ api, state: memoryState().state, host: local.host, actor, roomId: async () => ROOM })).rejects.toThrow('PROFILE_DELETING');
  });
});
