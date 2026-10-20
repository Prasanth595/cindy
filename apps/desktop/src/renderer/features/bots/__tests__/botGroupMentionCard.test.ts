import { describe, expect, it } from 'vitest';
import type { BotGroupMemberView } from '../../../../shared/botGroupChat';
import { botGroupMentionMember } from '../BotGroupMentionCard';

const member = (botId: string, name: string): BotGroupMemberView =>
  ({ botId, name, avatar: '', avatarColor: 'gray', status: 'active' });

// PR #6549 review: the card must follow the message's mention ids, not the first name match.
describe('botGroupMentionMember', () => {
  const members = [member('a', 'Nova'), member('b', 'Nova'), member('c', '所有人')];

  it('opens the card of the member the message mentioned when two share a name', () => {
    expect(botGroupMentionMember('@Nova', members, { all: false, botIds: ['b'] }, '所有人')?.botId).toBe('b');
  });

  it('opens no card for the broadcast, even with a member named like it', () => {
    expect(botGroupMentionMember('@所有人', members, { all: true, botIds: [] }, '所有人')).toBeUndefined();
    expect(botGroupMentionMember('@所有人', members, { all: false, botIds: ['c'] }, '所有人')?.botId).toBe('c');
  });

  it('opens no card for a name the message did not mention', () => {
    expect(botGroupMentionMember('@Nova', members, { all: false, botIds: [] }, '所有人')).toBeUndefined();
  });
});
