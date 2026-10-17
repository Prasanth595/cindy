import { createLogger } from '../logger.js';
import {
  addBotImConnection,
  findBotImConnectionByIdentity,
  parseBotImConnectionAddInput,
} from '../im/shared/botImConnectionRuntime.js';
import { object } from './types.js';

const log = createLogger('bot-import:im-bot');

/** Long enough for a still-running source gateway to answer Telegram polling with 409. */
const TELEGRAM_CONFLICT_WINDOW_MS = 5_000;

/**
 * Connect an imported Telegram / Discord bot as the companion's own connection.
 * Returns an advisory issue code instead of throwing: the import keeps the
 * credential for delivery either way. Tokens never reach logs or the result.
 */
export async function connectImportedImBot(botId: string, credential: { format: string; value: unknown }): Promise<string | undefined> {
  if (credential.format !== 'telegram' && credential.format !== 'discord') return undefined;
  const channel = credential.format;
  const value = object(credential.value);
  const token = typeof value.token === 'string' ? value.token.trim() : '';
  const ownerUserId = typeof value.ownerUserId === 'string' ? value.ownerUserId.trim() : '';
  if (!ownerUserId) return 'IMPORT_IM_BOT_OWNER_MISSING';
  try {
    const existing = token ? findBotImConnectionByIdentity(channel, token) : null;
    // Retried imports find the connection they already created.
    if (existing) return existing.botId === botId ? undefined : 'IMPORT_IM_BOT_IN_USE';
    const input = parseBotImConnectionAddInput({ botId, channel, token, ownerUserId });
    await addBotImConnection(input, { rejectConflictWithinMs: channel === 'telegram' ? TELEGRAM_CONFLICT_WINDOW_MS : 0 });
    return undefined;
  } catch (error) {
    // IPC errors read "[CODE] message"; the runtime's messages carry codes and platform reasons, never the token.
    const message = error instanceof Error ? error.message : '';
    const issue = /\bownerUserId is invalid\b/.test(message) ? 'IMPORT_IM_BOT_OWNER_MISSING'
      : /\b(TOKEN_IN_USE|APP_IN_USE):/.test(message) ? 'IMPORT_IM_BOT_IN_USE'
        : /\bCONNECT_FAILED: conflict$/.test(message) ? 'IMPORT_IM_BOT_GATEWAY_RUNNING'
          : 'IMPORT_IM_BOT_CONNECT_FAILED';
    log.warn(`imported ${channel} bot connection not created: ${issue}`);
    return issue;
  }
}
