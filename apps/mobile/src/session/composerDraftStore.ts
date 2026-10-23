import AsyncStorage from '@react-native-async-storage/async-storage';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';
import { mobileDraftScopeKey } from './draftOwnerScope';
import { composerDocumentsEqual, parseStoredComposerDocument, composerDocumentProjectedText, prependComposerNodes, textComposerDocument, type ComposerDocument, type ComposerNode } from '@/session/composerDocument';

// v1 keys have no owner evidence. Preserve them for rollback, but never assign
// their contents to whichever account happens to sign in after upgrading.
const STORAGE_KEY_PREFIX = 'xdt.mobileComposerDraft.v2';
const DOCUMENT_STORAGE_KEY_PREFIX = 'xdt.mobileComposerDocument.v2';
const PERSIST_DEBOUNCE_MS = 400;
const drafts = new Map<string, string>();
const clearedDrafts = new Set<string>();
const clearedDocumentDrafts = new Set<string>();
const pendingPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingDocumentPersistTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pendingStorageOperations = new Map<string, Promise<void>>();
const documentDrafts = new Map<string, ComposerDocument>();
const recoveryListeners = new Map<string, Set<(document: ComposerDocument) => void>>();
let clearGeneration = 0;

export function saveComposerDraft(sessionId: string, text: string | null | undefined, owner = getMobileAuthOwner()): void {
  const normalizedSessionId = mobileDraftScopeKey(sessionId, owner);
  if (!normalizedSessionId) return;

  const key = storageKeyForSession(normalizedSessionId);
  const value = text ?? '';
  if (value.length === 0) {
    cancelPendingPersist(normalizedSessionId);
    drafts.delete(normalizedSessionId);
    clearedDrafts.add(normalizedSessionId);
    enqueueStorageOperation(normalizedSessionId, () => AsyncStorage.removeItem(key));
    return;
  }

  drafts.set(normalizedSessionId, value);
  clearedDrafts.delete(normalizedSessionId);
  schedulePersist(normalizedSessionId, key, value);
}

export function saveComposerDocumentDraft(sessionId: string, document: ComposerDocument, owner = getMobileAuthOwner()): void {
  const normalizedSessionId = mobileDraftScopeKey(sessionId, owner);
  if (!normalizedSessionId) return;
  const key = documentStorageKeyForSession(normalizedSessionId);
  if (document.nodes.length === 0) {
    cancelPendingDocumentPersist(normalizedSessionId);
    documentDrafts.delete(normalizedSessionId);
    clearedDocumentDrafts.add(normalizedSessionId);
    enqueueStorageOperation(normalizedSessionId, () => AsyncStorage.removeItem(key));
    return;
  }
  documentDrafts.set(normalizedSessionId, document);
  clearedDocumentDrafts.delete(normalizedSessionId);
  const serialized = JSON.stringify(document);
  scheduleDocumentPersist(normalizedSessionId, key, document, serialized);
}

export function readComposerDocumentDraftSync(sessionId: string, owner = getMobileAuthOwner()): ComposerDocument | null {
  const normalizedSessionId = mobileDraftScopeKey(sessionId, owner);
  if (!normalizedSessionId || clearedDocumentDrafts.has(normalizedSessionId)) return null;
  return documentDrafts.get(normalizedSessionId) ?? null;
}

export async function readComposerDocumentDraft(sessionId: string, owner = getMobileAuthOwner()): Promise<ComposerDocument | null> {
  const normalizedSessionId = mobileDraftScopeKey(sessionId, owner);
  if (!normalizedSessionId) return null;
  const memory = documentDrafts.get(normalizedSessionId);
  if (memory) return memory;
  if (clearedDocumentDrafts.has(normalizedSessionId)) return null;
  const generation = clearGeneration;
  const stored = await AsyncStorage.getItem(documentStorageKeyForSession(normalizedSessionId)).catch(() => null);
  if (generation !== clearGeneration || !isMobileAuthOwnerCurrent(owner)) return null;
  const freshMemory = documentDrafts.get(normalizedSessionId);
  if (freshMemory) return freshMemory;
  if (clearedDocumentDrafts.has(normalizedSessionId)) return null;
  if (!stored) return null;
  try {
    const parsed = parseStoredComposerDocument(JSON.parse(stored));
    if (!parsed) return null;
    documentDrafts.set(normalizedSessionId, parsed);
    return parsed;
  } catch {
    return null;
  }
}

export function readComposerDraftSync(sessionId: string, owner = getMobileAuthOwner()): string | null {
  const normalizedSessionId = mobileDraftScopeKey(sessionId, owner);
  if (!normalizedSessionId) return null;
  if (clearedDrafts.has(normalizedSessionId)) return null;
  return drafts.get(normalizedSessionId) ?? null;
}

export async function readComposerDraft(sessionId: string, owner = getMobileAuthOwner()): Promise<string | null> {
  const normalizedSessionId = mobileDraftScopeKey(sessionId, owner);
  if (!normalizedSessionId) return null;

  const memoryDraft = drafts.get(normalizedSessionId);
  if (memoryDraft !== undefined) return memoryDraft;
  if (clearedDrafts.has(normalizedSessionId)) return null;

  const generation = clearGeneration;
  const storedDraft = await AsyncStorage.getItem(storageKeyForSession(normalizedSessionId)).catch(() => null);
  if (generation !== clearGeneration || !isMobileAuthOwnerCurrent(owner)) return null;
  const freshMemoryDraft = drafts.get(normalizedSessionId);
  if (freshMemoryDraft !== undefined) return freshMemoryDraft;
  if (clearedDrafts.has(normalizedSessionId)) return null;
  if (!storedDraft) return null;
  drafts.set(normalizedSessionId, storedDraft);
  return storedDraft;
}

export async function consumeComposerDraft(sessionId: string, owner = getMobileAuthOwner()): Promise<string | null> {
  const value = await readComposerDraft(sessionId, owner);
  clearComposerDraft(sessionId, owner);
  return value;
}

export function clearComposerDraft(sessionId: string, owner = getMobileAuthOwner()): void {
  const normalizedSessionId = mobileDraftScopeKey(sessionId, owner);
  if (!normalizedSessionId) return;
  cancelPendingPersist(normalizedSessionId);
  cancelPendingDocumentPersist(normalizedSessionId);
  drafts.delete(normalizedSessionId);
  clearedDrafts.add(normalizedSessionId);
  documentDrafts.delete(normalizedSessionId);
  clearedDocumentDrafts.add(normalizedSessionId);
  enqueueStorageOperation(normalizedSessionId, () => AsyncStorage.multiRemove([
    storageKeyForSession(normalizedSessionId),
    documentStorageKeyForSession(normalizedSessionId),
  ]));
}

export async function clearComposerDrafts(): Promise<void> {
  clearGeneration += 1;
  cancelAllPendingPersists();
  cancelAllPendingDocumentPersists();
  drafts.clear();
  documentDrafts.clear();
  clearedDrafts.clear();
  clearedDocumentDrafts.clear();
  await drainPendingStorageOperations();
  const keys = await AsyncStorage.getAllKeys().catch(() => [] as readonly string[]);
  const ownedKeys = keys.filter((key) => (
    key.startsWith(`${STORAGE_KEY_PREFIX}.`) || key.startsWith(`${DOCUMENT_STORAGE_KEY_PREFIX}.`)
  ));
  if (ownedKeys.length === 0) return;
  await AsyncStorage.multiRemove(ownedKeys).catch(() => undefined);
}

export async function flushComposerDraftWrites(sessionId?: string, owner = getMobileAuthOwner()): Promise<void> {
  // Unmount may follow owner invalidation. Finish only edits already accepted
  // into that owner's queue; never reinterpret its task ID under the next login.
  const normalizedSessionId = sessionId === undefined ? undefined
    : owner.accountKey && sessionId.trim() ? JSON.stringify([owner.accountKey, sessionId.trim()]) : '';
  if (sessionId !== undefined && !normalizedSessionId) return;
  const pending = normalizedSessionId
    ? pendingPersistTimers.has(normalizedSessionId)
      ? [[normalizedSessionId, pendingPersistTimers.get(normalizedSessionId)!] as const]
      : []
    : [...pendingPersistTimers.entries()];
  const pendingDocuments = normalizedSessionId
    ? pendingDocumentPersistTimers.has(normalizedSessionId)
      ? [[normalizedSessionId, pendingDocumentPersistTimers.get(normalizedSessionId)!] as const]
      : []
    : [...pendingDocumentPersistTimers.entries()];

  for (const [pendingSessionId, timer] of pending) {
    clearTimeout(timer);
    pendingPersistTimers.delete(pendingSessionId);
  }
  for (const [pendingSessionId, timer] of pendingDocuments) {
    clearTimeout(timer);
    pendingDocumentPersistTimers.delete(pendingSessionId);
  }

  await Promise.all([
    ...pending.map(([pendingSessionId]) => {
      const value = drafts.get(pendingSessionId);
      if (value === undefined) return Promise.resolve();
      return persistIfCurrent(pendingSessionId, storageKeyForSession(pendingSessionId), value);
    }),
    ...pendingDocuments.map(([pendingSessionId]) => {
      const document = documentDrafts.get(pendingSessionId);
      if (!document) return Promise.resolve();
      return persistDocumentIfCurrent(
        pendingSessionId,
        documentStorageKeyForSession(pendingSessionId),
        document,
        JSON.stringify(document),
      );
    }),
  ]);
  await drainPendingStorageOperations(normalizedSessionId);
}

/** Only recovery broadcasts: ordinary edits keep their existing local source. */
export function subscribeComposerDraftRecovery(
  sessionId: string,
  listener: (document: ComposerDocument) => void,
  owner: MobileAuthOwnerGeneration = getMobileAuthOwner(),
): () => void {
  const id = mobileDraftScopeKey(sessionId, owner);
  if (!id) return () => undefined;
  const guarded = (document: ComposerDocument) => {
    if (isMobileAuthOwnerCurrent(owner)) listener(document);
  };
  const bucket = recoveryListeners.get(id) ?? new Set<(document: ComposerDocument) => void>();
  bucket.add(guarded);
  recoveryListeners.set(id, bucket);
  return () => {
    bucket.delete(guarded);
    if (bucket.size === 0) recoveryListeners.delete(id);
  };
}

/** A legacy direct send may optimistically clear before preparation finishes.
 * Capture while authorized; recovery can only return these exact bytes to this
 * account/task. It cannot read another scope or accept a later editor value. */
export function captureComposerDraftRecovery(
  sessionId: string,
  document: ComposerDocument,
  owner: MobileAuthOwnerGeneration = getMobileAuthOwner(),
): { restore(): Promise<void>; discard(): void } | null {
  const id = mobileDraftScopeKey(sessionId, owner);
  if (!id) return null;
  let captured = parseStoredComposerDocument(JSON.parse(JSON.stringify(document)));
  if (!captured) return null;
  const generation = clearGeneration;
  let restored = false;
  let discarded = false;
  let inFlight: Promise<void> | null = null;
  return {
    discard() { discarded = true; captured = null; },
    restore() {
      if (discarded || generation !== clearGeneration) return Promise.resolve();
      if (inFlight) return inFlight;
      if (!restored) {
        const later = documentDrafts.get(id) ?? textComposerDocument(drafts.get(id) ?? '');
        const prefix: ComposerNode[] = [...captured!.nodes];
        if (prefix.length && later.nodes.length
          && prefix.at(-1)?.type !== 'quote' && later.nodes[0].type !== 'quote') {
          prefix.push({ type: 'text', text: '\n\n' });
        }
        const recovered = prependComposerNodes(later, prefix);
        // Publish to the original namespace before queuing I/O. A write failure
        // retains the only recovery material; later edits remain authoritative.
        documentDrafts.set(id, recovered);
        drafts.set(id, composerDocumentProjectedText(recovered));
        clearedDocumentDrafts.delete(id);
        clearedDrafts.delete(id);
        restored = true;
        for (const listener of [...(recoveryListeners.get(id) ?? [])]) listener(recovered);
      }
      cancelPendingPersist(id);
      cancelPendingDocumentPersist(id);
      const nextDocument = documentDrafts.get(id);
      const nextText = drafts.get(id);
      const pending = enqueueStorageOperation(id, async () => {
        if (discarded || generation !== clearGeneration) return;
        if (nextDocument) await AsyncStorage.setItem(documentStorageKeyForSession(id), JSON.stringify(nextDocument));
        else await AsyncStorage.removeItem(documentStorageKeyForSession(id));
        if (nextText) await AsyncStorage.setItem(storageKeyForSession(id), nextText);
        else await AsyncStorage.removeItem(storageKeyForSession(id));
      }, true);
      inFlight = pending.then(() => {
        discarded = true;
        captured = null;
      }, (error) => {
        inFlight = null;
        throw error;
      });
      return inFlight;
    },
  };
}

/** Finish a committed send's draft handoff in the existing per-session write chain.
 * Failures propagate so the outbox keeps its recovery proof. Later user edits win.
 */
export async function reconcileCommittedComposerDraft(
  sessionId: string,
  handoff: { before: ComposerDocument; after: ComposerDocument },
  guard: () => void,
  owner: MobileAuthOwnerGeneration = getMobileAuthOwner(),
): Promise<void> {
  const id = mobileDraftScopeKey(sessionId, owner);
  guard();
  if (!id) throw new Error('OUTBOX_OWNER_CHANGED');
  const check = () => {
    guard();
    if (!isMobileAuthOwnerCurrent(owner)) throw new Error('OUTBOX_OWNER_CHANGED');
  };
  await flushComposerDraftWrites(sessionId, owner);
  await enqueueStorageOperation(id, async () => {
    check();
    const documentKey = documentStorageKeyForSession(id);
    const textKey = storageKeyForSession(id);
    const raw = await AsyncStorage.getItem(documentKey);
    const text = await AsyncStorage.getItem(textKey);
    check();
    const stored = raw ? parseStoredComposerDocument(JSON.parse(raw)) : null;
    if (raw && !stored) throw new Error('COMPOSER_DRAFT_INVALID');
    const memory = documentDrafts.get(id);
    const next = memory && !composerDocumentsEqual(memory, handoff.before)
      ? memory : stored && !composerDocumentsEqual(stored, handoff.before)
        ? stored : handoff.after;
    const replaceDocument = !!stored && composerDocumentsEqual(stored, handoff.before);
    const beforeText = composerDocumentProjectedText(handoff.before);
    const nextText = drafts.get(id);
    const replacementText = nextText !== undefined && nextText !== beforeText
      ? nextText : composerDocumentProjectedText(next);
    if (memory && composerDocumentsEqual(memory, handoff.before)) {
      documentDrafts.set(id, next);
      cancelPendingDocumentPersist(id);
    }
    if (nextText === beforeText) {
      drafts.set(id, replacementText);
      cancelPendingPersist(id);
    }
    if (replaceDocument) {
      await AsyncStorage.setItem(documentKey, JSON.stringify(next));
      check();
    }
    if (text === beforeText) {
      await AsyncStorage.setItem(textKey, replacementText);
      check();
    }
  }, true);
}

function storageKeyForSession(normalizedSessionId: string): string {
  return `${STORAGE_KEY_PREFIX}.${encodeURIComponent(normalizedSessionId)}`;
}

function documentStorageKeyForSession(normalizedSessionId: string): string {
  return `${DOCUMENT_STORAGE_KEY_PREFIX}.${encodeURIComponent(normalizedSessionId)}`;
}

function schedulePersist(normalizedSessionId: string, key: string, value: string): void {
  cancelPendingPersist(normalizedSessionId);
  const timer = setTimeout(() => {
    pendingPersistTimers.delete(normalizedSessionId);
    void persistIfCurrent(normalizedSessionId, key, value);
  }, PERSIST_DEBOUNCE_MS);
  pendingPersistTimers.set(normalizedSessionId, timer);
}

function scheduleDocumentPersist(
  normalizedSessionId: string,
  key: string,
  document: ComposerDocument,
  serialized: string,
): void {
  cancelPendingDocumentPersist(normalizedSessionId);
  const timer = setTimeout(() => {
    pendingDocumentPersistTimers.delete(normalizedSessionId);
    void persistDocumentIfCurrent(normalizedSessionId, key, document, serialized);
  }, PERSIST_DEBOUNCE_MS);
  pendingDocumentPersistTimers.set(normalizedSessionId, timer);
}

function cancelPendingPersist(normalizedSessionId: string): void {
  const timer = pendingPersistTimers.get(normalizedSessionId);
  if (!timer) return;
  clearTimeout(timer);
  pendingPersistTimers.delete(normalizedSessionId);
}

function cancelPendingDocumentPersist(normalizedSessionId: string): void {
  const timer = pendingDocumentPersistTimers.get(normalizedSessionId);
  if (!timer) return;
  clearTimeout(timer);
  pendingDocumentPersistTimers.delete(normalizedSessionId);
}

function cancelAllPendingPersists(): void {
  for (const timer of pendingPersistTimers.values()) clearTimeout(timer);
  pendingPersistTimers.clear();
}

function cancelAllPendingDocumentPersists(): void {
  for (const timer of pendingDocumentPersistTimers.values()) clearTimeout(timer);
  pendingDocumentPersistTimers.clear();
}

async function persistIfCurrent(normalizedSessionId: string, key: string, value: string): Promise<void> {
  if (clearedDrafts.has(normalizedSessionId)) return;
  if (drafts.get(normalizedSessionId) !== value) return;
  await enqueueStorageOperation(normalizedSessionId, () => AsyncStorage.setItem(key, value));
}

async function persistDocumentIfCurrent(
  normalizedSessionId: string,
  key: string,
  document: ComposerDocument,
  serialized: string,
): Promise<void> {
  if (clearedDocumentDrafts.has(normalizedSessionId)) return;
  if (documentDrafts.get(normalizedSessionId) !== document) return;
  await enqueueStorageOperation(normalizedSessionId, () => AsyncStorage.setItem(key, serialized));
}

function enqueueStorageOperation(
  normalizedSessionId: string,
  operation: () => Promise<void>,
  propagateError = false,
): Promise<void> {
  const previous = pendingStorageOperations.get(normalizedSessionId) ?? Promise.resolve();
  const result = previous
    .catch(() => undefined)
    .then(operation);
  const next = result.catch(() => undefined);
  pendingStorageOperations.set(normalizedSessionId, next);
  void next.finally(() => {
    if (pendingStorageOperations.get(normalizedSessionId) === next) {
      pendingStorageOperations.delete(normalizedSessionId);
    }
  });
  return propagateError ? result : next;
}

async function drainPendingStorageOperations(normalizedSessionId?: string): Promise<void> {
  const pending = normalizedSessionId
    ? pendingStorageOperations.has(normalizedSessionId)
      ? [pendingStorageOperations.get(normalizedSessionId)!]
      : []
    : [...pendingStorageOperations.values()];
  await Promise.all(pending);
}

export const __testing = {
  documentStorageKeyForSession: (sessionId: string) => documentStorageKeyForSession(mobileDraftScopeKey(sessionId)),
  persistDebounceMs: PERSIST_DEBOUNCE_MS,
  storageKeyForSession: (sessionId: string) => storageKeyForSession(mobileDraftScopeKey(sessionId)),
  storageKeyPrefix: STORAGE_KEY_PREFIX,
};
