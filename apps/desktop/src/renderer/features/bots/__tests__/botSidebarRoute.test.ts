import { describe, expect, it } from 'vitest';

import { resolveOpenChatRoute } from '../botSidebarRoute';

describe('resolveOpenChatRoute', () => {
  it('伙伴首页与列表页不算打开了某个聊天', () => {
    expect(resolveOpenChatRoute('/bots')).toBeNull();
    expect(resolveOpenChatRoute('/bots/')).toBeNull();
    expect(resolveOpenChatRoute('/bots/list')).toBeNull();
    expect(resolveOpenChatRoute('/bots/roster')).toBeNull();
  });

  it('本机伙伴的首页与其子路由都指向同一个伙伴', () => {
    expect(resolveOpenChatRoute('/bots/bot-1')).toEqual({ kind: 'bot', botId: 'bot-1' });
    expect(resolveOpenChatRoute('/bots/bot-1/session/s-1')).toEqual({ kind: 'bot', botId: 'bot-1' });
    expect(resolveOpenChatRoute('/bots/bot-1/history/s-1')).toEqual({ kind: 'bot', botId: 'bot-1' });
    expect(resolveOpenChatRoute('/bots/bot-1/direct/t-1')).toEqual({ kind: 'bot', botId: 'bot-1' });
  });

  it('远程伙伴带设备,不与同名本机伙伴混淆', () => {
    expect(resolveOpenChatRoute('/bots/remote/desk-1/bot-1')).toEqual({
      kind: 'remote',
      deviceId: 'desk-1',
      botId: 'bot-1',
    });
    expect(resolveOpenChatRoute('/bots/remote/desk-1/bot-1/settings')).toEqual({
      kind: 'remote',
      deviceId: 'desk-1',
      botId: 'bot-1',
    });
  });

  it('群聊优先于 :botId,并解出编码过的群 id', () => {
    expect(resolveOpenChatRoute('/bots/groups/g%2F1')).toEqual({ kind: 'group', groupId: 'g/1' });
    expect(resolveOpenChatRoute('/bots/groups/g-1')).toEqual({ kind: 'group', groupId: 'g-1' });
  });

  it('其它路由不匹配', () => {
    expect(resolveOpenChatRoute('/cc-agent/session-1')).toBeNull();
    expect(resolveOpenChatRoute('/settings/models')).toBeNull();
  });
});
