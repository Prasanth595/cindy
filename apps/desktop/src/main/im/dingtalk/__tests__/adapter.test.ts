import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';

import type { DingTalkIM, IMMessageEvent } from '@cindy/im';
import {
  buildDingTalkAdapter,
  dingtalkManagedWorkingDirName,
  dingtalkSessionIdFor,
} from '../adapter';

const CONFIG = {
  agentKind: 'claude-code' as const,
  defaultModel: 'claude-opus-4-7',
  defaultPermissionMode: 'auto' as const,
  effortOverrides: { 'claude-opus-4-7': 'xhigh' as const },
};

describe('dingtalk managed working directory identity', () => {
  it('keeps normal app keys readable and backward compatible', () => {
    expect(dingtalkManagedWorkingDirName('ding_app-123')).toBe('dingtalk-ding_app-123');
  });

  it('hashes unsafe app keys instead of collapsing replacement collisions', () => {
    const slashKey = dingtalkManagedWorkingDirName('ding/app');
    const dashKey = dingtalkManagedWorkingDirName('ding-app');

    expect(slashKey).toMatch(/^dingtalk-external-[a-f0-9]{24}$/);
    expect(slashKey).not.toBe(dashKey);
  });

  it('hashes long app keys instead of collapsing suffix truncation collisions', () => {
    const sharedSuffix = 'x'.repeat(128);
    const first = dingtalkManagedWorkingDirName(`first-${sharedSuffix}`);
    const second = dingtalkManagedWorkingDirName(`second-${sharedSuffix}`);

    expect(first).toMatch(/^dingtalk-external-[a-f0-9]{24}$/);
    expect(first).not.toBe(second);
    expect(dingtalkManagedWorkingDirName(`first-${sharedSuffix}`)).toBe(first);
  });
});

describe('dingtalk session identity', () => {
  it('keeps distinct lane ids distinct after encoding', () => {
    const percentEncodedLane = dingtalkSessionIdFor('ding-app', 'g/a%2Fb');
    const dashLane = dingtalkSessionIdFor('ding-app', 'g/a-2Fb');

    expect(percentEncodedLane).not.toBe(dashLane);
  });

  it('is stable, reversible, and session-id safe', () => {
    const appKey = 'ding_app/中国';
    const userId = 'g/conversation_with_underscore/话题';
    const sessionId = dingtalkSessionIdFor(appKey, userId);
    const encodedIdentity = sessionId.slice('dingtalk_'.length);

    expect(sessionId).toMatch(/^dingtalk_[a-zA-Z0-9_-]+$/);
    expect(dingtalkSessionIdFor(appKey, userId)).toBe(sessionId);
    expect(JSON.parse(Buffer.from(encodedIdentity, 'base64url').toString('utf8'))).toEqual([
      appKey,
      userId,
    ]);
  });
});

describe('dingtalk turn permission boundary', () => {
  const adapter = buildDingTalkAdapter({} as DingTalkIM, CONFIG);
  const baseEvent = {
    channelName: 'dingtalk',
    senderId: 'owner-user',
    chatId: 'conversation-1',
    contextId: 'ding-app',
    messageId: 'message-1',
    text: 'run task',
    attachments: [],
    unsupported: [],
  } satisfies IMMessageEvent;

  it('主人私聊遵循 session permissionMode，不叠加与完全访问互斥的逐轮策略', () => {
    expect(adapter.turnPermissionPolicyFor?.(baseEvent)).toBeUndefined();
  });

  it('群聊保留逐轮危险操作强确认', () => {
    const policy = adapter.turnPermissionPolicyFor?.({
      ...baseEvent,
      senderId: 'g/conversation-1',
      speaker: {
        id: 'member-1',
        name: '成员',
        isOwner: false,
      },
    });

    expect(policy?.origin).toEqual({
      kind: 'im',
      channel: 'dingtalk',
      taskId: 'message-1',
    });
    expect(policy?.forceConfirmToolCall('file_change', {})).toBe(true);
  });
});

describe('dingtalk teammate-owned connection', () => {
  const im = { getOwnerUserId: () => 'owner-1' } as unknown as DingTalkIM;

  it('maps the TOFU owner DM, other DMs and group conversations to companion lanes', () => {
    const adapter = buildDingTalkAdapter(im, CONFIG, { companionBotId: 'bot-mia' });
    expect(adapter.companionLane?.('owner-1')).toEqual({ kind: 'owner-dm' });
    expect(adapter.companionLane?.('stranger')).toEqual({ kind: 'guest-dm', userId: 'stranger' });
    expect(adapter.companionLane?.('g/cid%2F1')).toEqual({ kind: 'group', chatId: 'cid/1', threadId: '' });
    // 还没人私聊过(TOFU 未发生)时谁都不是主人。
    const unbound = buildDingTalkAdapter({ getOwnerUserId: () => '' } as unknown as DingTalkIM, CONFIG, { companionBotId: 'bot-mia' });
    expect(unbound.companionLane?.('owner-1')).toEqual({ kind: 'guest-dm', userId: 'owner-1' });
  });

  it('lets owner-triggered group turns run on the teammate permission tier and keeps the guest policy', () => {
    const adapter = buildDingTalkAdapter(im, CONFIG, { companionBotId: 'bot-mia' });
    const personal = buildDingTalkAdapter(im, CONFIG);
    const ownerEvent = { messageId: 'm1', speaker: { id: 'owner-1', name: 'Owner', isOwner: true } } as unknown as IMMessageEvent;
    const guestEvent = { messageId: 'm2', speaker: { id: 'g', name: 'Guest', isOwner: false } } as unknown as IMMessageEvent;
    expect(adapter.turnPermissionPolicyFor?.(ownerEvent)).toBeUndefined();
    expect(adapter.turnPermissionPolicyFor?.(guestEvent)).toBeDefined();
    expect(personal.turnPermissionPolicyFor?.(ownerEvent)).toBeDefined();
    expect(adapter.turnPermissionPolicyFor?.({ messageId: 'dm' } as IMMessageEvent)).toBeUndefined();
  });
});
