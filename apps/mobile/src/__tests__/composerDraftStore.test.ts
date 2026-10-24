import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMobileAuthOwner, invalidateMobileAuthOwnerForSwitch, isMobileAuthOwnerCurrent, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import * as drafts from '@/session/composerDraftStore';
import { composerDocumentProjectedText, composerDocumentQuotes, emptyComposerDocument, hydrateComposerMessageReferenceBodies, normalizeComposerDocument, sessionLinkComposerNode, textComposerDocument } from '@/session/composerDocument';
import { buildLearnStartRequest, parseMobileDesktopCommand } from '@/session/desktopSlashCommands';

const store = vi.hoisted(() => new Map<string, string>());

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => store.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    getAllKeys: vi.fn(async () => [...store.keys()]),
    multiRemove: vi.fn(async (keys: readonly string[]) => {
      for (const key of keys) store.delete(key);
    }),
  },
}));

describe('composerDraftStore', () => {
  // Unit: /learn accepts an unresolved message chip as an argument. Its real
  // hydration yields after optimistic consumption, so owner loss must return
  // only consumed nodes; the quote left in the composer must not be duplicated.
  it('recovers an un-dispatched learn command after message hydration changes owner, retaining one quote', async () => {
    const owner = getMobileAuthOwner();
    const original = normalizeComposerDocument({ version: 1, nodes: [
      { type: 'quote', quote: { text: 'retained quote' } },
      { type: 'text', text: '/learn 总结 ' },
      sessionLinkComposerNode({ href: 'cindy://session/source?message=message-a', label: 'message-a' }),
    ] });
    const command = parseMobileDesktopCommand(composerDocumentProjectedText(original));
    expect(command?.name).toBe('learn');
    const consumed = normalizeComposerDocument({ version: 1, nodes: original.nodes.filter(node => node.type !== 'quote') });
    const retained = normalizeComposerDocument({ version: 1, nodes: original.nodes.filter(node => node.type === 'quote') });
    const recovery = drafts.captureComposerDraftRecovery('shared', consumed, owner)!;
    drafts.saveComposerDocumentDraft('shared', retained);
    drafts.saveComposerDraft('shared', composerDocumentProjectedText(retained));
    let release!: (value: { label: string; agentText: string }) => void;
    const resolveMessage = vi.fn(() => new Promise<{ label: string; agentText: string }>(resolve => { release = resolve; }));
    const learnStart = vi.fn();
    const preparing = hydrateComposerMessageReferenceBodies(original, resolveMessage).then(async () => {
      if (!isMobileAuthOwnerCurrent(owner)) await recovery.restore();
      else { recovery.discard(); learnStart(buildLearnStartRequest(command!.args, 'shared')); }
    });
    expect(resolveMessage).toHaveBeenCalledOnce();
    setMobileAuthOwner('other-owner');
    drafts.saveComposerDocumentDraft('shared', textComposerDocument('other account'));
    release({ label: 'Resolved message', agentText: 'resolved body' });
    await preparing;
    expect(learnStart).not.toHaveBeenCalled();
    expect(drafts.readComposerDocumentDraftSync('shared')).toEqual(textComposerDocument('other account'));
    setMobileAuthOwner('draft-owner');
    const restored = drafts.readComposerDocumentDraftSync('shared')!;
    expect(composerDocumentProjectedText(restored)).toBe(composerDocumentProjectedText(original));
    expect(composerDocumentQuotes(restored)).toEqual([{ text: 'retained quote' }]);
    expect(restored.nodes.some(node => node.type === 'session-link' && node.messageClientId === 'message-a')).toBe(true);
  });

  // Unit regression from the account-isolation review: legacy Plan sends clear
  // before async preparation, but cannot use ordinary stale-owner saves to
  // recover. Capture the production recovery boundary while still authorized.
  it('restores a cancelled preparation only to its original account, before later edits, once', async () => {
    const original = textComposerDocument('unsent plan');
    drafts.saveComposerDocumentDraft('shared', original);
    drafts.saveComposerDraft('shared', 'unsent plan');
    const recovery = drafts.captureComposerDraftRecovery('shared', original)!;
    original.nodes = [{ type: 'text', text: 'mutated caller snapshot' }];
    drafts.saveComposerDocumentDraft('shared', emptyComposerDocument());
    drafts.saveComposerDraft('shared', '');
    drafts.saveComposerDocumentDraft('shared', textComposerDocument('later edit'));
    drafts.saveComposerDraft('shared', 'later edit');
    setMobileAuthOwner('other-owner', 'global');
    drafts.saveComposerDocumentDraft('shared', textComposerDocument('other account'));
    drafts.saveComposerDraft('shared', 'other account');
    await recovery.restore();
    await recovery.restore();
    expect(drafts.readComposerDraftSync('shared')).toBe('other account');
    setMobileAuthOwner('draft-owner', 'global');
    expect(drafts.readComposerDocumentDraftSync('shared')).toEqual(textComposerDocument('unsent plan\n\nlater edit'));
    expect(store.get(drafts.__testing.storageKeyForSession('shared'))).toBe('unsent plan\n\nlater edit');
  });

  it.each(['discarded', 'cleared'] as const)('does not restore an explicitly %s snapshot or mint a retired recovery', async (outcome) => {
    const owner = getMobileAuthOwner();
    const document = textComposerDocument('unsent plan');
    const recovery = drafts.captureComposerDraftRecovery('shared', document)!;
    if (outcome === 'discarded') recovery.discard();
    else await drafts.clearComposerDrafts();
    setMobileAuthOwner('other-owner', 'global');
    expect(drafts.captureComposerDraftRecovery('shared', document, owner)).toBeNull();
    await recovery.restore();
    setMobileAuthOwner('draft-owner', 'global');
    expect(drafts.readComposerDocumentDraftSync('shared')).toBeNull();
    expect(store.has(drafts.__testing.documentStorageKeyForSession('shared'))).toBe(false);
  });

  it.each(['document', 'text'] as const)('retains the recovered snapshot after a failed %s write and retries without duplication', async (failure) => {
    const storage = (await import('@react-native-async-storage/async-storage')).default;
    const recovery = drafts.captureComposerDraftRecovery('shared', textComposerDocument('unsent plan'))!;
    const documentKey = drafts.__testing.documentStorageKeyForSession('shared');
    const textKey = drafts.__testing.storageKeyForSession('shared');
    if (failure === 'text') vi.mocked(storage.setItem).mockImplementationOnce(async (key, value) => { store.set(key, value); });
    vi.mocked(storage.setItem).mockRejectedValueOnce(new Error('disk busy'));
    await expect(recovery.restore()).rejects.toThrow('disk busy');
    expect(drafts.readComposerDocumentDraftSync('shared')).toEqual(textComposerDocument('unsent plan'));
    await recovery.restore();
    expect(JSON.parse(store.get(documentKey)!)).toEqual(textComposerDocument('unsent plan'));
    expect(store.get(textKey)).toBe('unsent plan');
  });

  it('orders a later edit after recovery writes already in flight', async () => {
    const storage = (await import('@react-native-async-storage/async-storage')).default;
    let release!: () => void;
    vi.mocked(storage.setItem).mockImplementationOnce((key, value) => new Promise(resolve => {
      release = () => { store.set(key, value); resolve(); };
    }));
    const recovery = drafts.captureComposerDraftRecovery('shared', textComposerDocument('unsent plan'))!;
    const restoring = recovery.restore();
    await flushMicrotasks();
    drafts.saveComposerDocumentDraft('shared', textComposerDocument('new edit'));
    drafts.saveComposerDraft('shared', 'new edit');
    const flushing = drafts.flushComposerDraftWrites('shared');
    release();
    await restoring;
    await flushing;
    expect(drafts.readComposerDraftSync('shared')).toBe('new edit');
    expect(store.get(drafts.__testing.storageKeyForSession('shared'))).toBe('new edit');
    expect(JSON.parse(store.get(drafts.__testing.documentStorageKeyForSession('shared'))!)).toEqual(textComposerDocument('new edit'));
  });

  it('delivers a late recovery to the newly mounted original owner, never the retired editor or another account', async () => {
    const retired = vi.fn();
    const other = vi.fn();
    const current = vi.fn();
    const offRetired = drafts.subscribeComposerDraftRecovery('shared', retired);
    const recovery = drafts.captureComposerDraftRecovery('shared', textComposerDocument('unsent plan'))!;
    setMobileAuthOwner('other-owner');
    const offOther = drafts.subscribeComposerDraftRecovery('shared', other);
    setMobileAuthOwner('draft-owner');
    const offCurrent = drafts.subscribeComposerDraftRecovery('shared', current);
    try {
      drafts.saveComposerDocumentDraft('shared', textComposerDocument('new input'));
      await recovery.restore();
      expect(current).toHaveBeenCalledExactlyOnceWith(textComposerDocument('unsent plan\n\nnew input'));
      expect(retired).not.toHaveBeenCalled();
      expect(other).not.toHaveBeenCalled();
    } finally { offRetired(); offOther(); offCurrent(); }
  });

  it.each(['both', 'text-only', 'new-draft'] as const)('reconciles a committed send after a crash with %s remaining', async (state) => {
    const { __testing, reconcileCommittedComposerDraft, readComposerDraft, readComposerDocumentDraft } = await import('@/session/composerDraftStore');
    const { textComposerDocument, emptyComposerDocument } = await import('@/session/composerDocument');
    const before = textComposerDocument('already sent');
    const after = emptyComposerDocument();
    store.set(__testing.storageKeyForSession('s1'), state === 'new-draft' ? 'later edit' : 'already sent');
    if (state !== 'text-only') store.set(__testing.documentStorageKeyForSession('s1'), JSON.stringify(state === 'new-draft' ? textComposerDocument('later edit') : before));
    await reconcileCommittedComposerDraft('s1', { before, after }, () => {});
    expect(await readComposerDraft('s1')).toBe(state === 'new-draft' ? 'later edit' : null);
    expect(await readComposerDocumentDraft('s1')).toEqual(state === 'new-draft' ? textComposerDocument('later edit') : state === 'text-only' ? null : after);
  });
  it('propagates draft handoff storage failure and retries the unmodified disk proof', async () => {
    const { __testing, reconcileCommittedComposerDraft } = await import('@/session/composerDraftStore');
    const { textComposerDocument, emptyComposerDocument } = await import('@/session/composerDocument');
    const storage = (await import('@react-native-async-storage/async-storage')).default;
    const before = textComposerDocument('sent');
    store.set(__testing.documentStorageKeyForSession('s1'), JSON.stringify(before));
    store.set(__testing.storageKeyForSession('s1'), 'sent');
    vi.mocked(storage.setItem).mockRejectedValueOnce(new Error('disk busy'));
    await expect(reconcileCommittedComposerDraft('s1', { before, after: emptyComposerDocument() }, () => {})).rejects.toThrow('disk busy');
    await reconcileCommittedComposerDraft('s1', { before, after: emptyComposerDocument() }, () => {});
    expect(store.get(__testing.storageKeyForSession('s1'))).toBe('');
  });
  beforeEach(async () => {
    setMobileAuthOwner('draft-owner', 'global');
    vi.useRealTimers();
    vi.clearAllMocks();
    const { clearComposerDrafts } = await import('@/session/composerDraftStore');
    await clearComposerDrafts();
    store.clear();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.useRealTimers();
    const { clearComposerDrafts } = await import('@/session/composerDraftStore');
    await clearComposerDrafts();
    store.clear();
    setMobileAuthOwner(null);
  });

  // Unit regression: shared tasks retain one sessionId across accounts. Existing
  // tests covered task switches only; account/realm changes must not expose an
  // unsent document, while returning to the original owner preserves it.
  it.each(['account', 'realm'] as const)('isolates a shared task draft across %s switches', async (scope) => {
    const before = getMobileAuthOwner();
    drafts.saveComposerDraft('shared', 'owner A');
    drafts.saveComposerDocumentDraft('shared', textComposerDocument('owner A'));
    invalidateMobileAuthOwnerForSwitch();
    setMobileAuthOwner(scope === 'account' ? 'other-owner' : 'draft-owner', scope === 'realm' ? 'cn' : 'global');
    expect(drafts.readComposerDraftSync('shared')).toBeNull();
    expect(drafts.readComposerDocumentDraftSync('shared')).toBeNull();
    drafts.saveComposerDraft('shared', 'owner B');
    drafts.saveComposerDocumentDraft('shared', textComposerDocument('owner B'));
    drafts.saveComposerDraft('shared', 'late A callback', before);
    drafts.saveComposerDocumentDraft('shared', textComposerDocument('late A callback'), before);
    drafts.clearComposerDraft('shared', before);
    await drafts.flushComposerDraftWrites('shared', before);
    expect(drafts.readComposerDraftSync('shared')).toBe('owner B');
    expect(drafts.readComposerDocumentDraftSync('shared')).toEqual(textComposerDocument('owner B'));
    setMobileAuthOwner('draft-owner', 'global');
    expect(drafts.readComposerDraftSync('shared')).toBe('owner A');
    expect(store.get(drafts.__testing.storageKeyForSession('shared'))).toBe('owner A');
  });

  // The old implementation also refilled cleared memory from a pending getItem.
  // Exercise the real read/consume paths, not just a new storage-key helper.
  it.each(['text', 'document', 'consume'] as const)('discards a retired %s hydration without clearing the next owner', async (kind) => {
    const storage = (await import('@react-native-async-storage/async-storage')).default;
    let finish!: (value: string | null) => void;
    vi.mocked(storage.getItem).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const reading = kind === 'document' ? drafts.readComposerDocumentDraft('shared')
      : kind === 'consume' ? drafts.consumeComposerDraft('shared') : drafts.readComposerDraft('shared');
    invalidateMobileAuthOwnerForSwitch();
    await drafts.clearComposerDrafts();
    setMobileAuthOwner('other-owner', 'global');
    drafts.saveComposerDraft('shared', 'new owner');
    drafts.saveComposerDocumentDraft('shared', textComposerDocument('new owner'));
    finish(kind === 'document' ? JSON.stringify(textComposerDocument('old owner')) : 'old owner');
    await expect(reading).resolves.toBeNull();
    expect(drafts.readComposerDraftSync('shared')).toBe('new owner');
    expect(drafts.readComposerDocumentDraftSync('shared')).toEqual(textComposerDocument('new owner'));
  });

  it('leaves unowned legacy bytes untouched and disables reads and writes while signed out', async () => {
    const legacyText = 'xdt.mobileComposerDraft.v1.shared';
    const legacyDocument = 'xdt.mobileComposerDocument.v1.shared';
    store.set(legacyText, 'unowned text');
    store.set(legacyDocument, JSON.stringify(textComposerDocument('unowned text')));
    await expect(drafts.readComposerDraft('shared')).resolves.toBeNull();
    await expect(drafts.readComposerDocumentDraft('shared')).resolves.toBeNull();
    setMobileAuthOwner(null);
    drafts.saveComposerDraft('shared', 'signed-out write');
    drafts.saveComposerDocumentDraft('shared', textComposerDocument('signed-out write'));
    await drafts.flushComposerDraftWrites();
    await drafts.clearComposerDrafts();
    expect([...store.keys()]).toEqual([legacyText, legacyDocument]);
    expect(store.get(legacyText)).toBe('unowned text');
  });

  it('stores a draft in memory and persistent storage until the target session consumes it', async () => {
    const {
      __testing,
      consumeComposerDraft,
      flushComposerDraftWrites,
      readComposerDraft,
      readComposerDraftSync,
      saveComposerDraft,
    } = await import('@/session/composerDraftStore');

    saveComposerDraft('s1', 'rewrite this');

    expect(readComposerDraftSync('s1')).toBe('rewrite this');
    await expect(readComposerDraft('s1')).resolves.toBe('rewrite this');
    expect(store.get(__testing.storageKeyForSession('s1'))).toBeUndefined();
    await flushComposerDraftWrites('s1');
    expect(store.get(__testing.storageKeyForSession('s1'))).toBe('rewrite this');
    await expect(consumeComposerDraft('s1')).resolves.toBe('rewrite this');
    expect(readComposerDraftSync('s1')).toBeNull();
    await expect(readComposerDraft('s1')).resolves.toBeNull();
  });

  it('restores a draft from persistent storage when memory is empty', async () => {
    const {
      __testing,
      clearComposerDrafts,
      readComposerDraft,
      readComposerDraftSync,
    } = await import('@/session/composerDraftStore');

    store.set(__testing.storageKeyForSession('s1'), 'from disk');
    expect(readComposerDraftSync('s1')).toBeNull();
    await expect(readComposerDraft('s1')).resolves.toBe('from disk');
    expect(readComposerDraftSync('s1')).toBe('from disk');

    await clearComposerDrafts();
  });

  it('persists the semantic document so atom order survives remounts', async () => {
    const {
      __testing,
      flushComposerDraftWrites,
      readComposerDocumentDraft,
      readComposerDocumentDraftSync,
      saveComposerDocumentDraft,
    } = await import('@/session/composerDraftStore');
    const document = {
      version: 1 as const,
      nodes: [
        { type: 'quote' as const, quote: { text: 'selected' } },
        { type: 'text' as const, text: 'reply' },
      ],
    };

    saveComposerDocumentDraft('s1', document);
    expect(readComposerDocumentDraftSync('s1')).toEqual(document);
    await flushComposerDraftWrites('s1');
    expect(JSON.parse(store.get(__testing.documentStorageKeyForSession('s1')) ?? '')).toEqual(document);
    await expect(readComposerDocumentDraft('s1')).resolves.toEqual(document);
  });

  it('does not let a stale document read replace a newer semantic draft', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const {
      readComposerDocumentDraft,
      readComposerDocumentDraftSync,
      saveComposerDocumentDraft,
    } = await import('@/session/composerDraftStore');
    let resolveGetItem!: (value: string | null) => void;
    vi.mocked(asyncStorage.getItem).mockImplementationOnce(() => new Promise((resolve) => {
      resolveGetItem = resolve;
    }));
    const oldDocument = { version: 1, nodes: [{ type: 'text', text: 'old' }] };
    const newDocument = { version: 1 as const, nodes: [{ type: 'text' as const, text: 'new' }] };

    const readPromise = readComposerDocumentDraft('s1');
    saveComposerDocumentDraft('s1', newDocument);
    resolveGetItem(JSON.stringify(oldDocument));

    await expect(readPromise).resolves.toEqual(newDocument);
    expect(readComposerDocumentDraftSync('s1')).toEqual(newDocument);
  });

  it('clears empty drafts and ignores missing session ids', async () => {
    const {
      consumeComposerDraft,
      readComposerDraft,
      saveComposerDraft,
    } = await import('@/session/composerDraftStore');

    saveComposerDraft('', 'missing session');
    saveComposerDraft('s1', 'old text');
    saveComposerDraft('s1', '');

    await expect(consumeComposerDraft('')).resolves.toBeNull();
    await expect(readComposerDraft('s1')).resolves.toBeNull();
  });

  it('debounces persistent writes while keeping memory current', async () => {
    vi.useFakeTimers();
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const {
      __testing,
      readComposerDraftSync,
      saveComposerDraft,
    } = await import('@/session/composerDraftStore');

    saveComposerDraft('s1', 'r');
    saveComposerDraft('s1', 'rewrite');

    expect(readComposerDraftSync('s1')).toBe('rewrite');
    expect(vi.mocked(asyncStorage.setItem)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(__testing.persistDebounceMs - 1);
    expect(vi.mocked(asyncStorage.setItem)).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(vi.mocked(asyncStorage.setItem)).toHaveBeenCalledTimes(1);
    expect(store.get(__testing.storageKeyForSession('s1'))).toBe('rewrite');
  });

  it('debounces semantic document writes while keeping memory current', async () => {
    vi.useFakeTimers();
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const {
      __testing,
      readComposerDocumentDraftSync,
      saveComposerDocumentDraft,
    } = await import('@/session/composerDraftStore');
    const first = { version: 1 as const, nodes: [{ type: 'text' as const, text: 'r' }] };
    const latest = { version: 1 as const, nodes: [{ type: 'text' as const, text: 'rewrite' }] };

    saveComposerDocumentDraft('s1', first);
    saveComposerDocumentDraft('s1', latest);

    expect(readComposerDocumentDraftSync('s1')).toEqual(latest);
    expect(vi.mocked(asyncStorage.setItem)).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(__testing.persistDebounceMs);

    expect(vi.mocked(asyncStorage.setItem)).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.get(__testing.documentStorageKeyForSession('s1')) ?? '')).toEqual(latest);
  });

  it('does not let a stale async read overwrite a newer memory draft', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const {
      __testing,
      flushComposerDraftWrites,
      readComposerDraft,
      readComposerDraftSync,
      saveComposerDraft,
    } = await import('@/session/composerDraftStore');
    let resolveGetItem!: (value: string | null) => void;
    vi.mocked(asyncStorage.getItem).mockImplementationOnce(() => new Promise((resolve) => {
      resolveGetItem = resolve;
    }));

    const readPromise = readComposerDraft('s1');
    saveComposerDraft('s1', 'new draft');
    resolveGetItem('old draft');

    await expect(readPromise).resolves.toBe('new draft');
    expect(readComposerDraftSync('s1')).toBe('new draft');
    await flushComposerDraftWrites('s1');
    expect(store.get(__testing.storageKeyForSession('s1'))).toBe('new draft');
  });

  it('cancels pending persistent writes when a draft is cleared', async () => {
    vi.useFakeTimers();
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const {
      __testing,
      readComposerDraftSync,
      saveComposerDraft,
    } = await import('@/session/composerDraftStore');

    saveComposerDraft('s1', 'old draft');
    saveComposerDraft('s1', '');

    expect(readComposerDraftSync('s1')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(__testing.persistDebounceMs);
    expect(vi.mocked(asyncStorage.setItem)).not.toHaveBeenCalled();
    expect(store.get(__testing.storageKeyForSession('s1'))).toBeUndefined();
  });

  it('flushes pending clears before reporting durable draft state', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const {
      __testing,
      flushComposerDraftWrites,
      saveComposerDraft,
    } = await import('@/session/composerDraftStore');
    const key = __testing.storageKeyForSession('s1');
    let resolveRemove!: () => void;
    vi.mocked(asyncStorage.removeItem).mockImplementationOnce((removeKey: string) => new Promise((resolve) => {
      resolveRemove = () => {
        store.delete(removeKey);
        resolve();
      };
    }));
    store.set(key, 'old draft');

    saveComposerDraft('s1', '');
    let flushed = false;
    const flushPromise = flushComposerDraftWrites('s1').then(() => {
      flushed = true;
    });
    await flushMicrotasks();

    expect(flushed).toBe(false);
    expect(store.get(key)).toBe('old draft');
    expect(vi.mocked(asyncStorage.removeItem)).toHaveBeenCalledWith(key);

    resolveRemove();
    await flushPromise;

    expect(flushed).toBe(true);
    expect(store.get(key)).toBeUndefined();
  });

  it('orders a new persistent write after an in-flight clear', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    const {
      __testing,
      flushComposerDraftWrites,
      saveComposerDraft,
    } = await import('@/session/composerDraftStore');
    const key = __testing.storageKeyForSession('s1');
    let resolveRemove!: () => void;
    vi.mocked(asyncStorage.removeItem).mockImplementationOnce((removeKey: string) => new Promise((resolve) => {
      resolveRemove = () => {
        store.delete(removeKey);
        resolve();
      };
    }));
    store.set(key, 'old draft');

    saveComposerDraft('s1', '');
    saveComposerDraft('s1', 'new draft');
    const flushPromise = flushComposerDraftWrites('s1');
    await flushMicrotasks();

    expect(store.get(key)).toBe('old draft');
    expect(vi.mocked(asyncStorage.removeItem)).toHaveBeenCalledWith(key);

    resolveRemove();
    await flushPromise;

    expect(store.get(key)).toBe('new draft');
  });
});
