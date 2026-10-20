import { Route, Routes } from 'react-router-dom';
import { AppFrame, forbid, mountPage, subscription } from '../../ui-page/harness';
import { BotGroupChatView } from '../../../src/renderer/features/bots/BotGroupChatView';
import { ControlledBanner } from '../../../src/renderer/features/remote-device/ControlledBanner';

interface GroupData {
  name: string;
  members: Array<{ botId: string; name: string }>;
  messages: number;
  sidebar: boolean;
  /** A server group with teammates' bubbles: quote, reactions, thread entry and a task card. */
  bubbles?: boolean;
  wrappedReactions?: boolean;
}

const T0 = 1700000000000;
const MINUTE = 60_000;
const message = (fields: Record<string, unknown>) => ({
  kind: 'message',
  authorKind: 'user',
  authorBotId: null,
  authorName: '',
  mentions: { all: false, botIds: [] },
  noticeCode: null,
  planId: null,
  files: [],
  attachments: [],
  ...fields,
});

/** One of each piece a teammate's bubble carries, in a conversation order. */
function bubbleMessages(wrappedReactions = false) {
  const manyReactions = ['👍', '❤️', '😂', '🎉', '👀', '🙏', '✅', '🤔', '🔥', '👏', '🚀', '💯']
    .map((emoji) => ({ emoji, count: 1, me: false }));
  const sharedReply = {
    messageId: 'source-reply', threadRootId: 'source-root', status: 'available',
    authorKind: 'user', authorBotId: null, authorName: 'You', sharedByAuthor: true,
    content: '好', attachments: [], createdAt: T0 + 12 * MINUTE, edited: false, version: 1,
  };
  const ask = '周四发版前，把 Android 更新卡和伙伴群聊两个 PR 收口';
  const crash = '昨晚的崩溃上报一共 2 条，都来自旧版 0.1.60，新版没有复现。两份堆栈都停在图片解码那一步，我对比了两个版本的差异，0.1.61 已经限制了解码尺寸。';
  return [
    message({ id: 'q1', sequence: 1, isSelf: true, content: ask, createdAt: T0 }),
    message({
      id: 'a1', sequence: 2, authorKind: 'bot', authorBotId: 'a', authorName: 'Aster', createdAt: T0 + MINUTE,
      content: 'Android 更新卡那个 PR 的 review 已经处理完，现在等人审。',
      quote: { messageId: 'q1', authorName: 'You', authorKind: 'user', excerpt: ask, attachmentCount: 0, attachmentName: null, sequence: 1 },
      reactions: [{ emoji: '👍', count: 1, me: true }],
      replyCount: 5,
      threadPreview: { replies: [
        { id: 'r1', authorKind: 'user', authorBotId: null, authorName: 'You', isSelf: true, text: '截图我看过了，没问题', attachments: [], createdAt: T0 + 3 * MINUTE },
        { id: 'r2', authorKind: 'user', authorBotId: null, authorName: 'You', isSelf: true, text: '辛苦', attachments: [], createdAt: T0 + 4 * MINUTE },
      ], responders: [
        { id: 'r0a', authorKind: 'bot', authorBotId: 'a', authorName: 'Aster' },
        { id: 'r0b', authorKind: 'bot', authorBotId: 'b', authorName: 'Nova' },
        { id: 'r2', authorKind: 'user', authorBotId: null, authorName: 'You' },
      ] },
    }),
    message({ id: 'b1', sequence: 3, authorKind: 'bot', authorBotId: 'b', authorName: 'Nova', createdAt: T0 + 2 * MINUTE, content: crash }),
    message({
      id: 'b2', sequence: 4, authorKind: 'bot', authorBotId: 'b', authorName: 'Nova', createdAt: T0 + 3 * MINUTE,
      content: '剩下的 3 条 review 我开了个后台任务去修，修完告诉大家。',
      task: { state: 'started', title: '处理 #6458 剩余 review', meta: { v: 1, role: 'delegation-request', delegationId: 'd1' } },
    }),
    message({
      id: 'q2', sequence: 5, isSelf: true, createdAt: T0 + 9 * MINUTE, content: '@Nova 旧版那两条也记一下，发版说明里提一句',
      mentions: { all: false, botIds: wrappedReactions ? [] : ['b'] },
      quote: { messageId: 'b1', authorName: 'Nova', authorKind: 'bot', excerpt: crash, attachmentCount: 0, attachmentName: null, sequence: 3 },
      replyCount: 1,
      threadPreview: { replies: [
        { id: 'r3', authorKind: 'bot', authorBotId: 'b', authorName: 'Nova', text: '已经记下了', attachments: [], createdAt: T0 + 10 * MINUTE },
      ] },
    }),
    // Short messages with more reactions than the text is wide: the bubble widens to carry them.
    message({
      id: 'a2', sequence: 6, authorKind: 'bot', authorBotId: 'a', authorName: 'Aster', createdAt: T0 + 10 * MINUTE, content: '好',
      reactions: wrappedReactions ? manyReactions : ['👍', '🎉', '👀', '🙏'].map((emoji, i) => ({ emoji, count: i + 1, me: i === 0 })),
    }),
    message({
      id: 'q3', sequence: 7, isSelf: true, createdAt: T0 + 11 * MINUTE, content: '收到',
      replyCount: 3,
      threadPreview: { replies: [
        { id: 'r4', authorKind: 'bot', authorBotId: 'a', authorName: 'Aster', text: '好', attachments: [], createdAt: T0 + 12 * MINUTE },
        { id: 'r5', authorKind: 'bot', authorBotId: 'b', authorName: 'Nova', text: '已更新', attachments: [], createdAt: T0 + 13 * MINUTE },
        { id: 'r6', authorKind: 'user', authorBotId: null, authorName: 'You', isSelf: true, text: '谢谢', attachments: [], createdAt: T0 + 14 * MINUTE },
      ] },
      reactions: wrappedReactions ? manyReactions : ['❤️', '✅', '🚀'].map((emoji, i) => ({ emoji, count: i + 1, me: false })),
    }),
    message({
      id: 'q4', sequence: 8, isSelf: true, createdAt: T0 + 15 * MINUTE, content: '',
      threadShare: sharedReply, replyCount: 3,
      threadPreview: { replies: [
        { id: 'r7', authorKind: 'bot', authorBotId: 'a', authorName: 'Aster', text: '已记录', attachments: [], createdAt: T0 + 16 * MINUTE },
        { id: 'r8', authorKind: 'bot', authorBotId: 'b', authorName: 'Nova', text: '收到', attachments: [], createdAt: T0 + 17 * MINUTE },
        { id: 'r9', authorKind: 'user', authorBotId: null, authorName: 'You', isSelf: true, text: '谢谢', attachments: [], createdAt: T0 + 18 * MINUTE },
      ] },
    }),
    message({
      id: 'q5', sequence: 9, isSelf: true, createdAt: T0 + 19 * MINUTE, content: '',
      threadShare: sharedReply, reactions: manyReactions,
    }),
  ];
}

function groupFrom(data: GroupData) {
  return {
    id: 'fixture-group',
    name: data.name,
    replyMode: 'all',
    speakingMode: 'auto',
    members: data.members.map((member) => ({
      ...member,
      avatar: '',
      avatarColor: 'gray',
      status: 'active',
    })),
    organizerBotId: data.members[0]?.botId ?? null,
    projectDir: null,
    lastMessage: null,
    speakingBotIds: [],
    planningBotId: null,
    openPlan: null,
    createdAt: 1,
    updatedAt: 1,
    plans: [],
    ...(data.bubbles ? { serverBacked: true } : {}),
    messages: data.bubbles ? bubbleMessages(data.wrappedReactions) : Array.from({ length: data.messages }, (_, i) => ({
      id: `m${i}`,
      sequence: i + 1,
      kind: 'message',
      authorKind: 'user',
      authorBotId: null,
      authorName: '',
      content: `Layout message ${i + 1}`,
      mentions: { all: false, botIds: [] },
      noticeCode: null,
      planId: null,
      attachments: [],
      createdAt: 1700000000000 + i,
    })),
    hasMoreBefore: false,
    round: { status: 'idle', speakers: [], canContinue: false },
  };
}

void mountPage({
  route: '/bots/groups/fixture-group',
  host: (ctx) => {
    const group = groupFrom(ctx.data as unknown as GroupData);
    return {
      maker: {
        listBotGroups: async () => ({ ok: true, groups: [] }),
        getBotGroup: async () => ({ ok: true, group }),
        onBotGroupChanged: subscription('botGroupChanged'),
        sendBotGroupMessage: forbid('maker.sendBotGroupMessage'),
        stopBotGroupRound: forbid('maker.stopBotGroupRound'),
        chatServer: {
          reactors: async () => ({ ok: true, reactors: [{ actorId: 'me', isSelf: true, name: 'You', formerMember: false }] }),
          react: forbid('maker.chatServer.react'),
        },
      },
      deviceLink: {
        getState: async () => ({ controlledBy: [] }),
        onControlledState: subscription('controlledState'),
        revoke: forbid('deviceLink.revoke'),
      },
    };
  },
  render: (ctx) => {
    const data = ctx.data as unknown as GroupData;
    const sidebar = data.sidebar ? <div className="p-5" /> : undefined;
    return (
      <>
        <AppFrame sidebar={sidebar}>
          <div className="min-h-0 flex-1" data-ui-page-subject>
            <Routes>
              <Route path="/bots/groups/:groupId" element={<BotGroupChatView />} />
            </Routes>
          </div>
        </AppFrame>
        <ControlledBanner />
      </>
    );
  },
});
