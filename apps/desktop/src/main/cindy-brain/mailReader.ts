import { mailReaderMatches, parseMailMessage, type MailReaderDeclaration, type MailMessage } from '@cindy/maker-shared/mail-message';
import { RemoteResourceRegistryError, type RemoteResourceProvider } from '../device-link/remoteResourceRegistry.js';

export interface MailReaderPlugin { id: string; namespace?: string | null; enabled: boolean; reader: MailReaderDeclaration }
export interface MailPreviewResult { supported: boolean; message?: MailMessage; error?: string }
export function createMailReader(deps: {
  plugins(): MailReaderPlugin[];
  authorize(sessionId: string): Promise<void>;
  captureScope(): () => boolean;
  call(plugin: MailReaderPlugin, sessionId: string, url: string, markRead?: true): Promise<{ ok: boolean; result?: unknown; message?: string }>;
}) {
  return async (sessionId: unknown, url: unknown, read: unknown, opened: unknown = false): Promise<MailPreviewResult> => {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128 || typeof url !== 'string' || url.length > 2048 || typeof read !== 'boolean' || typeof opened !== 'boolean')
      throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Invalid mail link');
    const valid = deps.captureScope();
    await deps.authorize(sessionId);
    const check = () => { if (!valid()) throw new RemoteResourceRegistryError('NOT_FOUND', 'Mail unavailable'); };
    check();
    const candidates = deps.plugins().filter(p => p.enabled && mailReaderMatches(p.reader, url));
    if (!candidates.length) return { supported: false };
    if (!read) return { supported: true };
    if (candidates.length !== 1) return { supported: true, error: 'MAIL_PROVIDER_AMBIGUOUS' };
    const provider = candidates[0];
    const result = opened && provider.reader.markRead === true
      ? await deps.call(provider, sessionId, url, true)
      : await deps.call(provider, sessionId, url);
    check();
    await deps.authorize(sessionId); check();
    const message = result.ok ? parseMailMessage(result.result) : null;
    if (message?.conversation?.messages.some(m => !mailReaderMatches(candidates[0].reader, m.url))) {
      delete message.conversation;
      message.conversationUnavailable = true;
    }
    return message ? { supported: true, message } : { supported: true, error: 'MAIL_READ_FAILED' };
  };
}

/** Existing device-link resource transport, scoped exactly like plugin cards. */
export function mailReaderRemoteProvider(read: ReturnType<typeof createMailReader>): RemoteResourceProvider {
  const collectionId = 'mail-messages';
  return {
    collection: { id: collectionId, resourceKind: 'message', title: 'Mail' },
    async list() { return { collectionId, revision: '1', items: [] }; },
    async get(_context, request) {
      let args: unknown; try { args = JSON.parse(request.ref.id); } catch { /* validated below */ }
      if (!Array.isArray(args) || args.length !== 3) throw new RemoteResourceRegistryError('INVALID_PARAMS', 'Invalid mail link');
      // query is optional and ignored by older hosts; the existing read-only ID stays compatible.
      const result = await read(args[0], args[1], args[2], request.query === 'open');
      return { ref: request.ref, revision: '1', display: { title: result.message?.subject || 'Mail' }, links: [],
        blocks: [{ id: 'message', primitive: 'mail-message', fallbackMarkdown: result.message?.bodyText.slice(0, 16000) || '', data: result }] };
    },
  };
}
