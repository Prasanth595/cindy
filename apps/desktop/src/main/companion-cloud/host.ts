/** Local (Electron + SQLite + Bot Home) side of cloud companions; see runtime.ts. */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { and, asc, desc, eq, gt, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import { portableBotAvatarOrFallback, BOT_AVATAR_MAX_BYTES } from '../../shared/botAvatarValue.js';
import type { DeviceLinkDeviceView } from '../../shared/deviceLinkIpc.js';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile.js';
import { fetchPublicImageBytes } from '../im/publicImageFetch.js';
import { getDbClient } from '../localDb/client/current.js';
import { createBotProfile, getBotMemoryService, setBotProfileAvatar, updateBotProfile } from '../localDb/ipc/bots.js';
import { decodeBotAvatarImage } from '../localDb/ipc/botAvatarSelection.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { botProfiles, botSessionLinks, messages } from '../localDb/schema.js';
import { resolveBotCanonicalSession } from '../maker-ipc/botCanonicalSessionRegistry.js';
import { botProfileDir, botProfileMemoryDir, readBotProfileFolder, writeBotProfileFolder } from '../maker-ipc/botProfileFolder.js';
import { onBotRemoteResourceChanged } from '../maker-ipc/botRemoteResourceInvalidation.js';
import { deleteBotSkillForBot, listBotSkillSourcesForBot, readBotSkillSourceForBot, saveBotSkillSourceForBot } from '../maker-ipc/botSkillService.js';
import type { CompanionMaterializeHost } from './materialize.js';
import { companionHomes } from './homes.js';
import type { CompanionMirrorCursor, CompanionMirrorRow } from './mirror.js';
import type { CompanionCloudHost } from './runtime.js';
import { createCompanionCloudState } from './state.js';
import type { CompanionLog } from './types.js';
import {
  COMPANION_MEMORY_PREFIX,
  COMPANION_PROFILE_KEY,
  COMPANION_SKILL_PREFIX,
  type CompanionPreferenceValue,
} from './uploader.js';

/** Derived memory files: USER.md travels inside the profile, MEMORY.md is a rebuilt index. */
const SKIPPED_MEMORY_FILES = new Set(['USER.md', 'MEMORY.md']);

export async function readCompanionValues(botId: string): Promise<CompanionPreferenceValue[]> {
  const userDataDir = ownerScopedUserDataPath();
  const [row] = await getDbClient().drizzle
    .select({ displayName: botProfiles.displayName, description: botProfiles.description })
    .from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
  if (!row) return [];
  // Strict: an unreadable SOUL/USER/prompt file aborts the cycle instead of uploading it as empty.
  const folder = await readBotProfileFolder(userDataDir, botId, { strict: true });
  const values: CompanionPreferenceValue[] = [{ key: COMPANION_PROFILE_KEY, value: {
    name: row.displayName, description: row.description, soul: folder.identitySource,
    systemPrompt: folder.systemPromptOverride, user: folder.userContextSource,
  } }];
  const memoryDir = botProfileMemoryDir(userDataDir, botId);
  // Only a missing folder means "no memories"; any other read error aborts this cycle so the
  // uploader never tombstones memories it merely failed to read.
  const entries = await fs.readdir(memoryDir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.') || SKIPPED_MEMORY_FILES.has(entry.name)) continue;
    const content = await fs.readFile(path.join(memoryDir, entry.name), 'utf8');
    values.push({ key: `${COMPANION_MEMORY_PREFIX}${entry.name}`, value: { filename: entry.name, content } });
  }
  // Strict too: a skill that cannot be read must not look deleted (the uploader would tombstone it).
  for (const skill of await listBotSkillSourcesForBot(botId)) {
    values.push({ key: `${COMPANION_SKILL_PREFIX}${skill.slug}`, value: {
      slug: skill.slug, content: skill.source, ...(skill.enabled ? {} : { enabled: false }),
    } });
  }
  return values;
}

/** The SKILL.md as stored, so native frontmatter (tools, invocation, …) moves with the companion. */
async function readSkillContent(botId: string, slug: string): Promise<string | null> {
  return readBotSkillSourceForBot(botId, slug);
}

const AVATAR_FETCH_TIMEOUT_MS = 15_000;

/**
 * The actor's public avatar (https) as bounded image bytes for the normal creation path. Cloud
 * data is untrusted: the shared guarded download checks every hop against private networks and
 * stops reading at the size limit.
 */
async function fetchAvatarBase64(url: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const { buffer } = await fetchPublicImageBytes(url, BOT_AVATAR_MAX_BYTES, undefined, { signal, timeoutMs: AVATAR_FETCH_TIMEOUT_MS });
    return Buffer.from(buffer).toString('base64');
  } catch {
    return null;
  }
}

/**
 * The cloud avatar in a form the local profile holds; no usable cloud avatar means the same
 * default a new profile gets. A downloadable image that cannot be read throws: the take-over
 * must not finish with a stale avatar that the new home would publish.
 */
async function cloudAvatar(avatar: string | null, signal?: AbortSignal): Promise<{ portable: string } | { imageBase64: string }> {
  if (!avatar?.startsWith('https://')) return { portable: portableBotAvatarOrFallback(avatar) };
  const imageBase64 = await fetchAvatarBase64(avatar, signal);
  if (!imageBase64) throw new Error('AVATAR_UNAVAILABLE');
  return { imageBase64 };
}

type MaterializeLocal = Omit<CompanionMaterializeHost, 'latestRows'>;

function createMaterializer(input: {
  ensureCanonicalSession: (botId: string) => Promise<string>;
  rebuildContext: (sessionId: string) => Promise<'rebuilt' | 'busy'>;
}): MaterializeLocal {
  return {
    readProfile: async botId => {
      const [row] = await getDbClient().drizzle
        .select({ status: botProfiles.status, displayName: botProfiles.displayName, description: botProfiles.description })
        .from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
      return row ?? null;
    },
    // Normal creation path: no invitation, no generated persona, the new home's default model.
    createProfile: async ({ id, name, description, identitySource, userContextSource, avatar }, fence) => {
      const restored = await cloudAvatar(avatar, fence.signal);
      fence.assertCurrent();
      await createBotProfile({ id, name: name.slice(0, 200), description, identitySource, userContextSource,
        ...('portable' in restored ? { avatar: restored.portable } : { avatarImageBase64: restored.imageBase64 }) });
    },
    updateProfile: async ({ id, name, description, identitySource, userContextSource, avatar }, fence) => {
      const restored = await cloudAvatar(avatar, fence.signal);
      fence.assertCurrent();
      await updateBotProfile({ id, name: name.slice(0, 200), enabled: true,
        ...(description !== undefined ? { description } : {}),
        ...(identitySource !== undefined ? { identitySource } : {}),
        ...(userContextSource !== undefined ? { userContextSource } : {}),
        ...('portable' in restored ? { avatar: restored.portable } : {}) });
      if ('imageBase64' in restored) {
        const image = decodeBotAvatarImage(restored.imageBase64);
        fence.assertCurrent();
        if (image) await setBotProfileAvatar(id, image);
      }
    },
    writeSystemPrompt: async (botId, text, fence) => {
      const root = ownerScopedUserDataPath();
      fence.assertCurrent();
      await writeBotProfileFolder(root, botId, { systemPromptOverride: text });
    },
    backupHome: async (botId, fence) => {
      const source = botProfileDir(ownerScopedUserDataPath(), botId);
      const target = ownerScopedUserDataPath('companion-cloud-backups', `${path.basename(source)}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      fence.assertCurrent();
      // Only a missing folder means "nothing to back up"; any other error stops the take-over.
      try { await fs.access(source); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      // Identity, prompt, user file, memories and skills; the work folder stays where it is.
      await fs.cp(source, target, { recursive: true, filter: from => path.relative(source, from).split(path.sep)[0] !== 'workspace' });
      fence.assertCurrent();
      return target;
    },
    readMemory: async (botId, filename) => {
      if (path.basename(filename) !== filename) return null;
      // Only a missing file is "no memory"; other errors keep the take-over demoted for a retry.
      return fs.readFile(path.join(botProfileMemoryDir(ownerScopedUserDataPath(), botId), filename), 'utf8')
        .catch((error: NodeJS.ErrnoException) => { if (error?.code === 'ENOENT') return null; throw error; });
    },
    restoreMemory: (botId, filename, raw) => getBotMemoryService().restoreRaw(botId, filename, raw),
    removeMemory: (botId, filename) => getBotMemoryService().removeRaw(botId, filename),
    readSkill: readSkillContent,
    saveSkill: async (botId, slug, content, enabled) => { await saveBotSkillSourceForBot(botId, slug, content, { enabled }); },
    removeSkill: async (botId, slug) => { await deleteBotSkillForBot(botId, slug); },
    ensureCanonicalSession: botId => input.ensureCanonicalSession(botId),
    // Rewound and deleted rows are included (`removed`): removed here means never re-imported.
    localMessageTimes: async (sessionId, fromMs) => (await getDbClient().drizzle
      .select({ role: messages.role, createdAt: messages.createdAt, clientId: messages.clientId, rewindAt: messages.rewindAt }).from(messages)
      .where(and(eq(messages.sessionId, sessionId), inArray(messages.role, ['user', 'assistant', 'message_tombstone']), gte(messages.createdAt, fromMs))))
      .map(row => ({ role: row.role, createdAt: row.createdAt, clientId: row.clientId,
        ...(row.rewindAt !== null || row.role === 'message_tombstone' ? { removed: true } : {}) })),
    // Same row shape as ordinary messages; the client id keeps it out of the mirror.
    insertHistory: async (sessionId, row, fence) => {
      fence.assertCurrent();
      await createMessage(sessionId, { clientId: row.clientId, role: row.role, createdAt: row.createdAt,
        content: row.role === 'user' ? { text: row.text, images: [], files: [] } : [{ type: 'text', text: row.text }] });
    },
    rebuildContext: sessionId => input.rebuildContext(sessionId),
  };
}

const mirrorColumns = {
  id: messages.id, clientId: messages.clientId, role: messages.role, content: messages.content,
  agentMeta: messages.agentMeta, createdAt: messages.createdAt,
};
const visibleRows = (sessionId: string) => and(eq(messages.sessionId, sessionId), isNull(messages.rewindAt),
  inArray(messages.role, ['user', 'assistant']));

export async function readMirrorRowsAfter(sessionId: string, cursor: CompanionMirrorCursor, limit: number): Promise<CompanionMirrorRow[]> {
  return getDbClient().drizzle.select(mirrorColumns).from(messages)
    .where(and(visibleRows(sessionId), or(gt(messages.createdAt, cursor.createdAt),
      and(eq(messages.createdAt, cursor.createdAt), gt(messages.id, cursor.id)))))
    .orderBy(asc(messages.createdAt), asc(messages.id)).limit(limit);
}

export async function readLatestMirrorRows(sessionId: string, limit: number,
  options: { excludeClientIdPrefix?: string } = {}): Promise<CompanionMirrorRow[]> {
  const prefix = options.excludeClientIdPrefix;
  return getDbClient().drizzle.select(mirrorColumns).from(messages)
    .where(prefix ? and(visibleRows(sessionId), or(isNull(messages.clientId), sql`substr(${messages.clientId}, 1, ${prefix.length}) <> ${prefix}`)) : visibleRows(sessionId))
    .orderBy(desc(messages.createdAt), desc(messages.id)).limit(limit);
}

/** One random id per Cindy installation (userData), so two installs on one computer can tell themselves apart. */
export function companionInstallationId(): string {
  const file = path.join(app.getPath('userData'), 'companion-installation-id');
  try {
    const stored = readAtomicFileSync(file)?.trim();
    if (stored && /^[0-9a-f-]{36}$/.test(stored)) return stored;
  } catch { /* regenerate below */ }
  const created = randomUUID();
  atomicWriteFileSync(file, created);
  return created;
}

/** Owner-scoped list of shadowed (demoted) companions, read before the server answers. */
export function companionShadowStore() {
  const file = () => ownerScopedUserDataPath('companion-cloud', 'shadowed.json');
  return {
    read(): string[] {
      try {
        const value = JSON.parse(readAtomicFileSync(file()) ?? '[]');
        return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
      } catch { return []; }
    },
    write(ids: string[]) { atomicWriteFileSync(file(), JSON.stringify([...ids].sort())); },
  };
}

export function createCompanionCloudHost(input: {
  deliverToCanonical: CompanionCloudHost['deliverToCanonical'];
  ensureCanonicalSession: (botId: string) => Promise<string>;
  rebuildContext: (sessionId: string) => Promise<'rebuilt' | 'busy'>;
  /** A turn is running (or queued) in this Session. */
  isTurnActive?: (sessionId: string) => boolean;
  listDevices: () => Promise<DeviceLinkDeviceView[]>;
  probeCompanionCloud?: (deviceId: string) => Promise<boolean>;
  log?: CompanionLog;
}): CompanionCloudHost {
  // Every reader (send guards, routines, lists) sees only the active owner's homes, and that
  // owner's persisted demotion, even before its Chat Server instance has started.
  companionHomes.bindOwner(activeOwnerScopeKey, () => companionShadowStore().read());
  return {
    homes: companionHomes,
    openState: (endpoint, humanActorId, current) => createCompanionCloudState({
      filePath: ownerScopedUserDataPath('companion-cloud',
        `${createHash('sha256').update(`${endpoint}\n${humanActorId}`).digest('hex')}.json`),
      current, log: input.log,
    }),
    readValues: readCompanionValues,
    canonicalSession: async botId => {
      const resolved = await resolveBotCanonicalSession(botId);
      return resolved.status === 'resolved' ? resolved.sessionId : null;
    },
    rowsAfter: readMirrorRowsAfter,
    latestRows: readLatestMirrorRows,
    deliverToCanonical: input.deliverToCanonical,
    onLocalChange: onBotRemoteResourceChanged,
    materializer: createMaterializer(input),
    listDevices: input.listDevices,
    ...(input.isTurnActive ? { isBotBusy: async (botId: string) => {
      // Every live task the companion runs in: its main task, group lanes and delegations.
      const rows = await getDbClient().drizzle.select({ sessionId: botSessionLinks.sessionId }).from(botSessionLinks)
        .where(and(eq(botSessionLinks.botId, botId), isNull(botSessionLinks.archivedAt)));
      return rows.some(row => input.isTurnActive!(row.sessionId));
    } } : {}),
    ...(input.probeCompanionCloud ? { probeCompanionCloud: input.probeCompanionCloud } : {}),
    installationId: companionInstallationId,
    shadows: companionShadowStore(),
  };
}
