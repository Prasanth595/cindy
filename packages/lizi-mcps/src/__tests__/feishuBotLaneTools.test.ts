/**
 * cindy_feishu_bot 轮次内直通工具:作用域 fail closed、目标钉死、主人 / 成员分档、
 * call_api 的接口族与目标钳制、Open API 错误形态。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';

import { createFeishuBotMcpServer } from '../cindy_feishuBotMcpServer';
import type { FeishuBotLaneScope, FeishuBotLaneTransport } from '../types.js';

class FakeFeishuApiError extends Error {
  name = 'FeishuApiError';
  constructor(readonly code: number, readonly httpStatus: number, readonly apiMsg: string) {
    super(apiMsg);
  }
}

function fakeTransport(overrides: Partial<FeishuBotLaneTransport> = {}) {
  const t = {
    getService: vi.fn(() => 'feishu' as const),
    getBotAppId: vi.fn(() => 'cli_bot'),
    sendText: vi.fn(async () => ({ messageId: 'om_sent' })),
    sendMarkdownText: vi.fn(async () => ({ messageId: 'om_md' })),
    replyText: vi.fn(async () => ({ messageId: 'om_reply' })),
    replyMarkdownText: vi.fn(async () => ({ messageId: 'om_reply_md' })),
    sendFile: vi.fn(async () => ({ ok: true, messageId: 'om_file' })),
    reactToMessage: vi.fn(async () => 'rx_1'),
    removeMessageReaction: vi.fn(async () => undefined),
    getChatInfo: vi.fn(async () => ({ name: '产品群', chat_mode: 'group' })),
    listChatMembers: vi.fn(async () => ({ items: [{ memberId: 'ou_a', name: 'A' }], memberTotal: 1, nextPageToken: null })),
    // 默认: 任何别的消息都在别的群里。
    getMessage: vi.fn(async (id: string) => ({ message_id: id, chat_id: id === 'om_same' ? 'oc_here' : 'oc_other' })),
    pinMessage: vi.fn(async () => undefined),
    unpinMessage: vi.fn(async () => undefined),
    recallMessage: vi.fn(async () => undefined),
    callApi: vi.fn(async () => ({ code: 0, msg: 'ok', data: { ok: true } })),
    ...overrides,
  };
  return t as typeof t & FeishuBotLaneTransport;
}

function scopeOf(im: FeishuBotLaneTransport, overrides: Partial<FeishuBotLaneScope> = {}): FeishuBotLaneScope {
  return {
    im,
    laneUserId: 'g/oc_here',
    chatId: 'oc_here',
    threadId: '',
    chatKind: 'group',
    requesterIsOwner: true,
    triggerMessageId: 'om_trigger',
    companion: true,
    ...overrides,
  };
}

async function harness(getLaneScope?: () => FeishuBotLaneScope | null) {
  const server = createFeishuBotMcpServer({
    getChatId: () => 'oc_here',
    sendFile: vi.fn(async () => ({ ok: true })),
    sendMessage: vi.fn(async () => ({ ok: true, messageId: 'om_x' })),
    ...(getLaneScope ? { getLaneScope } : {}),
  });
  const [clientTx, serverTx] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'feishu-lane-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTx), client.connect(clientTx)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ text?: string }>;
    };
    return { isError: res.isError === true, payload: JSON.parse(res.content[0]?.text ?? '{}') as Record<string, unknown> };
  };
  return { client, call, close: async () => { await client.close(); await server.close(); } };
}

describe('cindy_feishu_bot 轮次内直通工具', () => {
  it('未注入作用域读取器时 server 形态不变(只有 list_tools / call_tool)', async () => {
    const h = await harness();
    expect((await h.client.listTools()).tools.map((t) => t.name).sort()).toEqual(['call_tool', 'list_tools']);
    await h.close();
  });

  it('注入后顶层出现具名工具; 没有活跃作用域时一律 fail closed', async () => {
    const h = await harness(() => null);
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'send_text', 'send_markdown', 'send_file', 'set_reaction', 'remove_reaction',
      'get_chat', 'get_message', 'pin_message', 'unpin_message', 'recall_message', 'call_api',
    ]));
    for (const [name, args] of [
      ['send_text', { text: 'hi' }],
      ['get_chat', {}],
      ['call_api', { method: 'GET', path: '/open-apis/im/v1/chats/oc_here' }],
    ] as const) {
      const r = await h.call(name, args);
      expect(r.isError).toBe(true);
      expect(r.payload.errorCode).toBe('NO_ACTIVE_FEISHU_SCOPE');
    }
    await h.close();
  });

  it('send_text / send_markdown 默认发到本轮 lane; 回复触发消息不需要额外校验', async () => {
    const im = fakeTransport();
    const h = await harness(() => scopeOf(im));
    expect((await h.call('send_text', { text: 'hello' })).payload).toEqual({ ok: true, messageId: 'om_sent' });
    expect(im.sendText).toHaveBeenCalledWith('g/oc_here', 'hello');
    const reply = await h.call('send_markdown', { markdown: '**ok**', reply_to_message_id: 'om_trigger' });
    expect(reply.payload).toEqual({ ok: true, messageId: 'om_reply_md', replyTo: 'om_trigger' });
    expect(im.replyMarkdownText).toHaveBeenCalledWith('om_trigger', '**ok**');
    expect(im.getMessage).not.toHaveBeenCalled();
    expect((await h.call('send_text', { text: '   ' })).payload.errorCode).toBe('EMPTY_TEXT');
    await h.close();
  });

  it('指定别的 message_id 时先确认它在本 chat; 群轮次(即使主人)不能碰别的群, 主人私聊可以', async () => {
    const im = fakeTransport();
    const group = await harness(() => scopeOf(im));
    const denied = await group.call('set_reaction', { emoji_type: 'THUMBSUP', message_id: 'om_elsewhere' });
    expect(denied.isError).toBe(true);
    expect(denied.payload.errorCode).toBe('PERMISSION_DENIED');
    expect(im.reactToMessage).not.toHaveBeenCalled();
    const same = await group.call('set_reaction', { emoji_type: 'THUMBSUP', message_id: 'om_same' });
    expect(same.payload).toEqual({ ok: true, messageId: 'om_same', reactionId: 'rx_1' });
    // 缺省落在触发消息上。
    expect((await group.call('set_reaction', { emoji_type: 'DONE' })).payload).toMatchObject({ messageId: 'om_trigger' });
    await group.close();

    const dm = await harness(() => scopeOf(im, { laneUserId: 'ou_owner', chatId: 'oc_p2p', chatKind: 'direct' }));
    expect((await dm.call('get_message', { message_id: 'om_elsewhere' })).payload).toMatchObject({ ok: true });
    await dm.close();
  });

  it('置顶 / 取消置顶 / 撤回需要主人触发; 成员触发 PERMISSION_DENIED', async () => {
    const im = fakeTransport();
    const guest = await harness(() => scopeOf(im, { requesterIsOwner: false }));
    for (const [name, args] of [
      ['pin_message', {}],
      ['unpin_message', { message_id: 'om_trigger' }],
      ['recall_message', { message_id: 'om_trigger' }],
    ] as const) {
      const r = await guest.call(name, args);
      expect(r.payload.errorCode).toBe('PERMISSION_DENIED');
    }
    expect(im.pinMessage).not.toHaveBeenCalled();
    // 成员仍可发消息 / 表情 / 读信息。
    expect((await guest.call('send_text', { text: 'ok' })).payload.ok).toBe(true);
    expect((await guest.call('get_chat', { include_members: true })).payload).toMatchObject({
      ok: true, chatId: 'oc_here', requesterIsOwner: false, chat: { name: '产品群' }, members: { memberTotal: 1 },
    });
    await guest.close();

    const owner = await harness(() => scopeOf(im));
    expect((await owner.call('pin_message', {})).payload).toEqual({ ok: true, messageId: 'om_trigger' });
    expect(im.pinMessage).toHaveBeenCalledWith('om_trigger');
    await owner.close();
  });

  it('call_api: 鉴权 / 应用管理接口任何人不开放; 成员只能 GET 或在本对话里发消息', async () => {
    const im = fakeTransport();
    const guest = await harness(() => scopeOf(im, { requesterIsOwner: false }));
    expect((await guest.call('call_api', { method: 'POST', path: '/open-apis/auth/v3/tenant_access_token/internal' })).payload.errorCode).toBe('PERMISSION_DENIED');
    expect((await guest.call('call_api', { method: 'DELETE', path: '/open-apis/im/v1/chats/oc_here/members' })).payload.errorCode).toBe('PERMISSION_DENIED');
    expect((await guest.call('call_api', { method: 'GET', path: 'im/v1/chats/oc_here' })).payload.errorCode).toBe('INVALID_PATH');
    expect((await guest.call('call_api', { method: 'GET', path: '/open-apis/im/v1/chats/oc_here' })).payload.ok).toBe(true);
    // 发消息: receive_id 自动钉到当前 chat。
    const sent = await guest.call('call_api', {
      method: 'POST', path: '/open-apis/im/v1/messages', data: { msg_type: 'text', content: '{"text":"hi"}' },
    });
    expect(sent.payload.ok).toBe(true);
    expect(im.callApi).toHaveBeenLastCalledWith({
      method: 'POST',
      path: '/open-apis/im/v1/messages',
      params: { receive_id_type: 'chat_id' },
      data: { msg_type: 'text', content: '{"text":"hi"}', receive_id: 'oc_here' },
    });
    await guest.close();
  });

  it('call_api: 群轮次里主人也不能把目标指到别的 chat / 别人私聊; 主人私聊轮次放开', async () => {
    const im = fakeTransport();
    const group = await harness(() => scopeOf(im));
    expect((await group.call('call_api', { method: 'GET', path: '/open-apis/im/v1/chats/oc_other' })).payload.errorCode).toBe('PERMISSION_DENIED');
    expect((await group.call('call_api', {
      method: 'POST', path: '/open-apis/im/v1/messages', params: { receive_id_type: 'open_id' }, data: { receive_id: 'ou_x', msg_type: 'text', content: '{}' },
    })).payload.errorCode).toBe('PERMISSION_DENIED');
    expect((await group.call('call_api', { method: 'GET', path: '/open-apis/im/v1/messages', params: { container_id_type: 'chat', chat_id: 'oc_other' } })).payload.errorCode).toBe('PERMISSION_DENIED');
    // 带 message_id 的路径按归属校验。
    expect((await group.call('call_api', { method: 'PATCH', path: '/open-apis/im/v1/messages/om_elsewhere', data: { content: '{}' } })).payload.errorCode).toBe('PERMISSION_DENIED');
    expect((await group.call('call_api', { method: 'PATCH', path: '/open-apis/im/v1/messages/om_trigger/urgent_app', data: { user_id_list: [] } })).payload.ok).toBe(true);
    await group.close();

    const dm = await harness(() => scopeOf(im, { laneUserId: 'ou_owner', chatId: 'oc_p2p', chatKind: 'direct' }));
    expect((await dm.call('call_api', { method: 'GET', path: '/open-apis/im/v1/chats/oc_other' })).payload.ok).toBe(true);
    await dm.close();
  });

  it('Open API 失败以业务码 + msg 回给模型; 其它异常不泄内部细节', async () => {
    const im = fakeTransport({
      callApi: vi.fn(async () => { throw new FakeFeishuApiError(99991663, 403, 'permission denied'); }),
      sendText: vi.fn(async () => { throw new Error('socket hang up at 10.0.0.1'); }),
    });
    const h = await harness(() => scopeOf(im));
    const api = await h.call('call_api', { method: 'GET', path: '/open-apis/im/v1/chats/oc_here' });
    expect(api.isError).toBe(true);
    expect(api.payload).toMatchObject({ errorCode: 'FEISHU_API_ERROR', code: 99991663, http_status: 403, msg: 'permission denied' });
    const text = await h.call('send_text', { text: 'x' });
    expect(text.payload.errorCode).toBe('INTERNAL');
    expect(JSON.stringify(text.payload)).not.toContain('10.0.0.1');
    await h.close();
  });
});
