/**
 * 自定义渠道传输层: token 校验、按 conversationId 分线、出站回调形状。
 */

import { describe, expect, it } from 'vitest';

import type { IMHost } from '@cindy/im';
import { createCustomIM } from '@cindy/im';

const TOKEN = 'b'.repeat(64);

function host(): IMHost {
  return {
    secrets: {
      write: () => true,
      read: () => null,
      remove: () => {},
      isAvailable: () => true,
    },
    ipc: {
      throwIpcError: (code: string, message: string) => {
        throw new Error(`${code}: ${message}`);
      },
      handle: () => {},
      broadcast: () => {},
    },
    paths: { feishuMediaDir: '/tmp' },
    httpPostForm: async () => ({ status: 200, body: null }),
  };
}

describe('CustomIM', () => {
  it('token 不符不入站; 合法入站带 scopeKey=conversationId', () => {
    const im = createCustomIM(host(), {
      displayName: 'ERP',
      token: TOKEN,
      callbackUrl: null,
    });
    const events: Array<{ chatId: string; scopeKey?: string }> = [];
    im.onMessage((e) => events.push({ chatId: e.chatId, scopeKey: e.scopeKey }));

    expect(im.handleInbound('wrong', { conversationId: 'c1', text: 'hi' })).toBe(false);
    expect(im.handleInbound(TOKEN, { conversationId: 'c1', text: 'hi' })).toBe(true);
    expect(events).toEqual([{ chatId: 'c1', scopeKey: 'c1' }]);
  });

  it('终稿回调带 conversationId、terminal 与附件绝对路径', async () => {
    const delivered: Array<{ url: string; body: unknown; token: string }> = [];
    const im = createCustomIM(host(), {
      displayName: 'ERP',
      token: TOKEN,
      callbackUrl: 'http://127.0.0.1:9/hook',
      resolveAttachment: (absPath) => ({ name: absPath.split('/').pop() ?? 'file', mimeType: 'text/plain' }),
      deliver: async (url, body, token) => void delivered.push({ url, body, token }),
    });

    await im.commitFinal({
      userId: 'c1',
      text: 'done',
      terminal: 'done',
      mediaAbsPaths: ['/tmp/out.txt'],
    });

    expect(delivered).toEqual([
      {
        url: 'http://127.0.0.1:9/hook',
        token: TOKEN,
        body: {
          conversationId: 'c1',
          text: 'done',
          terminal: 'done',
          attachments: [{ absPath: '/tmp/out.txt', name: 'out.txt' }],
        },
      },
    ]);
  });

  it('没有 callbackUrl 时只入站, 不发请求', async () => {
    const delivered: unknown[] = [];
    const im = createCustomIM(host(), {
      displayName: 'ERP',
      token: TOKEN,
      callbackUrl: null,
      deliver: async () => void delivered.push(1),
    });
    await im.commitFinal({ userId: 'c1', text: 'done', terminal: 'done' });
    expect(delivered).toEqual([]);
  });
});
