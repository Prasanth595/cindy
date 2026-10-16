/**
 * 企业微信 adapter 的伙伴连接契约: TOFU 主人私聊进主任务, 群按 chat 一条专线, 其它私聊按访客。
 */
import { describe, expect, it } from 'vitest';

import type { WecomIM } from '@cindy/im';
import { encodeWecomGroupLane } from '@cindy/im';

import { buildWecomAdapter } from '../adapter';
import type { WecomTextInteractions } from '../textInteractions';

const CONFIG = {
  agentKind: 'claude-code' as const,
  defaultModel: 'claude-opus-4-7',
  defaultPermissionMode: 'auto' as const,
  effortOverrides: { 'claude-opus-4-7': 'xhigh' as const },
};
const interactions = {} as unknown as WecomTextInteractions;

describe('wecom teammate-owned connection', () => {
  it('maps the TOFU owner DM, other DMs and group chats to companion lanes', () => {
    const im = { getOwnerUserId: () => 'zhangsan' } as unknown as WecomIM;
    const adapter = buildWecomAdapter(im, interactions, CONFIG, { companionBotId: 'bot-mia' });
    expect(adapter.companionLane?.('zhangsan')).toEqual({ kind: 'owner-dm' });
    expect(adapter.companionLane?.('lisi')).toEqual({ kind: 'guest-dm', userId: 'lisi' });
    expect(adapter.companionLane?.(encodeWecomGroupLane('wrk-chat-1'))).toEqual({
      kind: 'group',
      chatId: 'wrk-chat-1',
      threadId: '',
    });
    // 坏掉的群 lane 不炸, 按访客私聊处理。
    expect(adapter.companionLane?.('group/!!')).toEqual({ kind: 'guest-dm', userId: 'group/!!' });
    const unbound = buildWecomAdapter({ getOwnerUserId: () => '' } as unknown as WecomIM, interactions, CONFIG, {
      companionBotId: 'bot-mia',
    });
    expect(unbound.companionLane?.('zhangsan')).toEqual({ kind: 'guest-dm', userId: 'zhangsan' });
  });
});
