/** Local (Electron + SQLite + Bot Home) side of cloud companions; see runtime.ts. */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { and, asc, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { botProfiles, messages } from '../localDb/schema.js';
import { resolveBotCanonicalSession } from '../maker-ipc/botCanonicalSessionRegistry.js';
import { botProfileMemoryDir, readBotProfileFolder } from '../maker-ipc/botProfileFolder.js';
import { onBotRemoteResourceChanged } from '../maker-ipc/botRemoteResourceInvalidation.js';
import { listBotSkillsForBot, readBotSkillForBot } from '../maker-ipc/botSkillService.js';
import { renderBotSkillFile } from '../maker-ipc/botSkillStore.js';
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
  const folder = await readBotProfileFolder(userDataDir, botId);
  const values: CompanionPreferenceValue[] = [{ key: COMPANION_PROFILE_KEY, value: {
    name: row.displayName, description: row.description, soul: folder.identitySource,
    systemPrompt: folder.systemPromptOverride, user: folder.userContextSource,
  } }];
  const memoryDir = botProfileMemoryDir(userDataDir, botId);
  const entries = await fs.readdir(memoryDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.') || SKIPPED_MEMORY_FILES.has(entry.name)) continue;
    const content = await fs.readFile(path.join(memoryDir, entry.name), 'utf8').catch(() => null);
    if (content !== null) values.push({ key: `${COMPANION_MEMORY_PREFIX}${entry.name}`, value: { filename: entry.name, content } });
  }
  for (const skill of await listBotSkillsForBot(botId)) {
    const detail = await readBotSkillForBot(botId, skill.slug);
    if (!detail) continue;
    values.push({ key: `${COMPANION_SKILL_PREFIX}${skill.slug}`, value: {
      slug: skill.slug,
      content: renderBotSkillFile({ slug: skill.slug, name: detail.name, description: detail.description, updatedAt: detail.updatedAt, body: detail.body }),
      ...(skill.enabled === false ? { enabled: false } : {}),
    } });
  }
  return values;
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

export async function readLatestMirrorRows(sessionId: string, limit: number): Promise<CompanionMirrorRow[]> {
  return getDbClient().drizzle.select(mirrorColumns).from(messages).where(visibleRows(sessionId))
    .orderBy(desc(messages.createdAt), desc(messages.id)).limit(limit);
}

export function createCompanionCloudHost(input: {
  deliverToCanonical: CompanionCloudHost['deliverToCanonical'];
  log?: CompanionLog;
}): CompanionCloudHost {
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
  };
}
