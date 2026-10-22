import { describe, expect, it, vi } from 'vitest';
import { createMailReader, mailReaderRemoteProvider } from '../mailReader.js';
import type { MailReaderDeclaration } from '@cindy/maker-shared/mail-message';

const message = { accountId: 'a', messageId: 'm', from: 'from@test.com', to: 'to@test.com', cc: '', bcc: '', subject: 'Subject', date: '', bodyText: 'Hello', bodyHtml: '<p>Hello</p>', attachments: [] };
const plugin = { id: 'test-mail', namespace: null, enabled: true, reader: { tool: 'read_mail', hosts: ['mail.example.com'] } };
function setup(markRead: unknown = undefined) {
  const call = vi.fn<Parameters<typeof createMailReader>[0]['call']>(async () => ({ ok: true, result: message }));
  const authorize = vi.fn(async () => {});
  let current = true;
  // Raw values also exercise declarations retained from an older manifest validator.
  const reader = createMailReader({ plugins: () => [{ ...plugin, reader: { ...plugin.reader, ...(markRead === undefined ? {} : { markRead }) } as MailReaderDeclaration }], call, authorize, captureScope: () => () => current });
  return { reader, call, authorize, expire: () => { current = false; } };
}
describe('common mailbox reader', () => {
  it.each([undefined, true, false, 'false', 'true', 0, 1, null, {}, []].map(markRead => ({ markRead })))('requires literal opt-in across local and remote reads (markRead=$markRead)', async ({ markRead }) => {
    const f = setup(markRead), url = 'https://mail.example.com/m';
    await f.reader('session', url, false, true);
    expect(f.call).not.toHaveBeenCalled();
    await f.reader('session', url, true);
    expect(f.call.mock.calls.at(-1)).toHaveLength(3);
    await f.reader('session', url, true, true);
    expect(f.call.mock.calls.at(-1)).toHaveLength(markRead === true ? 4 : 3);
    const provider = mailReaderRemoteProvider(f.reader);
    const request = { client: { protocolVersion: 1, primitives: ['mail-message'] }, ref: { collectionId: 'mail-messages', kind: 'message', id: JSON.stringify(['session', url, true]) } };
    await provider.get!({ controllerDeviceId: 'controller' }, request);
    expect(f.call.mock.calls.at(-1)).toHaveLength(3);
    await provider.get!({ controllerDeviceId: 'controller' }, { ...request, query: 'open' });
    expect(f.call.mock.calls.at(-1)).toHaveLength(markRead === true ? 4 : 3);
  });
  // Opening may mark read; probing, AI reads and neighboring preloads must not.
  it('passes read intent only for an authorized opening with an opted-in provider', async () => {
    const f = setup(true), url = 'https://mail.example.com/m';
    await f.reader('session', url, false, true);
    expect(f.call).not.toHaveBeenCalled();
    await f.reader('session', url, true);
    expect(f.call.mock.calls.at(-1)).toHaveLength(3);
    await f.reader('session', url, true, true);
    expect(f.call.mock.calls.at(-1)?.[3]).toBe(true);
    const legacy = setup();
    await legacy.reader('session', url, true, true);
    expect(legacy.call.mock.calls.at(-1)).toHaveLength(3);
    await expect(f.reader('session', url, true, 'true')).rejects.toThrow();
  });
  it('carries explicit remote opening intent without changing legacy resource IDs', async () => {
    const f = setup(true), provider = mailReaderRemoteProvider(f.reader);
    const request = { client: { protocolVersion: 1, primitives: ['mail-message'] }, ref: { collectionId: 'mail-messages', kind: 'message', id: JSON.stringify(['session', 'https://mail.example.com/m', true]) } };
    await provider.get!({ controllerDeviceId: 'controller' }, request);
    expect(f.call.mock.calls.at(-1)).toHaveLength(3);
    const result = await provider.get!({ controllerDeviceId: 'controller' }, { ...request, query: 'open' });
    expect(f.call.mock.calls.at(-1)?.[3]).toBe(true);
    expect(result.ref).toEqual(request.ref);
    f.authorize.mockRejectedValue(new Error('Forbidden'));
    f.call.mockClear();
    await expect(f.reader('session', 'https://mail.example.com/m', true, true)).rejects.toThrow('Forbidden');
    expect(f.call).not.toHaveBeenCalled();
  });
  // New optional history must survive IPC without trusting a plugin's foreign-host URL.
  it('validates conversation links while retaining a readable selected message', async () => {
    const f = setup();
    const summary = { messageId: 'm', from: 'A', date: '', subject: 'S', snippet: 'Hi', url: 'https://mail.example.com/message/m' };
    f.call.mockResolvedValue({ ok: true, result: { ...message, conversation: { threadId: 'thread', messages: [summary] } } } as never);
    expect((await f.reader('session', summary.url, true)).message?.conversation?.messages).toEqual([summary]);
    f.call.mockResolvedValue({ ok: true, result: { ...message, conversation: { threadId: 'thread', messages: [{ ...summary, url: 'https://foreign.example.com/m' }] } } } as never);
    const result = await f.reader('session', summary.url, true);
    expect(result.message?.bodyText).toBe('Hello');
    expect(result.message?.conversation).toBeUndefined();
    expect(result.message?.conversationUnavailable).toBe(true);
  });
  it('resolves only exact HTTPS provider hosts without invoking a tool', async () => {
    const f = setup();
    expect(await f.reader('session', 'https://mail.example.com/mail/#inbox/id', false)).toEqual({ supported: true });
    for (const url of ['https://mail.example.com.evil.com/a', 'http://mail.example.com/a', 'https://user@mail.example.com/a', 'https://mail.example.com:444/a'])
      expect(await f.reader('session', url, false)).toEqual({ supported: false });
    expect(f.call).not.toHaveBeenCalled();
  });
  it('uses only the declared read tool and returns validated data without publishing a card', async () => {
    const f = setup();
    expect(await f.reader('session', 'https://mail.example.com/mail/#id', true)).toEqual({ supported: true, message });
    expect(f.call).toHaveBeenCalledWith(plugin, 'session', 'https://mail.example.com/mail/#id');
  });
  it('does not return mail after account/owner changes', async () => {
    const f = setup();
    f.call.mockImplementation(async () => { f.expire(); return { ok: true, result: message }; });
    await expect(f.reader('session', 'https://mail.example.com/a', true)).rejects.toThrow();
  });
  it('does not read before session authorization', async () => {
    const f = setup(); f.authorize.mockRejectedValue(new Error('Forbidden'));
    await expect(f.reader('session', 'https://mail.example.com/a', true)).rejects.toThrow('Forbidden');
    expect(f.call).not.toHaveBeenCalled();
  });
});
