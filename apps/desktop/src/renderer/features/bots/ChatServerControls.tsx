import { chatErrorKey } from './chatError';
import { useRef, useState } from 'react';
import { ChatInviteDialog } from './ChatInviteDialog';
import { ChatReactionButton } from './ChatReactionButton';
import { UserPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MessageActionBar } from '@/components/chat/MessageActionBar';
import { shareSelectionStore } from '@/components/chat/shareSelectionStore';
import { SHARE_EXCLUDE_ATTR } from '@/lib/shareConversationImage';
import { Tip } from '@/components/ui/tooltip';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { toast } from '@/lib/toast';
import type { BotGroupDetail, BotGroupMemberView, BotGroupMessageView } from '../../../shared/botGroupChat';

const key = (name: string) => `bots.groupChat.server.${name}`;
const api = () => window.electronAPI.maker.chatServer;
const emojiChoices = ['👍', '❤️', '😂', '🎉', '👀', '🙏', '✅', '🤔', '🔥', '👏', '🚀', '💯'];
const iconClass = 'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] disabled:opacity-50';
export { chatErrorKey } from './chatError';

/** A message's reaction version: the room's reset version plus the message's own realtime changes. */
export const messageReactionRevision = (group: Pick<BotGroupDetail, 'reactionRevision' | 'reactionRevisions'>, messageId: string) =>
  `${group.reactionRevision ?? 0}:${group.reactionRevisions?.[messageId] ?? 0}`;

/**
 * `onQuote` is 引用回复: a new main-timeline message that quotes this one. `onReply` opens the
 * message's Thread (话题) — 创建话题 before anyone answered, 查看话题 after.
 */
export function ChatMessageActions({ groupId, shareScope, message, members, reactionRevision, align = message.isSelf ? 'right' : 'left', onQuote, onReply, replyCountShown = false, copyText, menuActions, onChanged }: {
  groupId?: string; shareScope: string; message: BotGroupMessageView; members?: BotGroupMemberView[]; reactionRevision?: string | number; align?: 'left' | 'right'; onQuote?: () => void; onReply?: () => void;
  /** The thread preview already shows the count; keep the toolbar icon quiet. */
  replyCountShown?: boolean;
  copyText?: string;
  menuActions?: Parameters<typeof MessageActionBar>[0]['menuActions'];
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [picker, setPicker] = useState(false);
  async function react(emoji: string, present: boolean) {
    if (!groupId || busyRef.current) return;
    busyRef.current = true; setBusy(true); setPicker(false);
    const owner = getDataOwnerGeneration();
    try {
      const result = await api().react({ groupId, messageId: message.id, emoji, present });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) toast.error(t(chatErrorKey(result.errorCode)));
      else onChanged();
    } catch { if (isDataOwnerGenerationCurrent(owner)) toast.error(t(key('requestFailed'))); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return (
    <div {...{ [SHARE_EXCLUDE_ATTR]: '' }} className="mt-1 flex flex-col gap-1">
      {!!message.reactions?.length && <div className={`flex flex-wrap items-center gap-1 ${align === 'right' ? 'justify-end' : ''}`}>
        {message.reactions.map(reaction => (
          <ChatReactionButton key={reaction.emoji} groupId={groupId} messageId={message.id} reaction={reaction} revision={reactionRevision} members={members}
            disabled={busy || !groupId} onToggle={() => void react(reaction.emoji, !reaction.me)} />
        ))}
      </div>}
      <MessageActionBar copyText={copyText ?? message.content} menuActions={menuActions} createdAt={message.createdAt ? new Date(message.createdAt).toISOString() : undefined}
        align={align} hovered simplifiedBotConversation
        onShareAsImage={() => shareSelectionStore.enter(shareScope, message.id)}
        quoteAction={onQuote ? { onClick: onQuote, label: t(key('quoteReply')) } : undefined}
        replyAction={onReply ? { onClick: onReply, count: replyCountShown ? undefined : message.replyCount,
          label: message.replyCount ? t(key('openTopic'), { count: message.replyCount }) : t(key('startTopic')) } : undefined}
        reactionAction={groupId ? { label: t(key('addReaction')), open: picker, onOpenChange: setPicker, disabled: busy,
          content: <div className="grid grid-cols-6 gap-1">{emojiChoices.map(emoji =>
            <button type="button" key={emoji} className={iconClass} aria-label={emoji}
              onClick={() => void react(emoji, !message.reactions?.some(r => r.emoji === emoji && r.me))}>{emoji}</button>)}</div>,
        } : undefined} />
    </div>
  );
}

/** Group owners and admins create or revoke invitation links from the group header. */
export function ChatInviteButton({ groupId }: { groupId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const title = t(key('invite'));
  return <>
    <Tip text={title}><button type="button" className={iconClass} style={WINDOW_NO_DRAG_STYLE} aria-label={title} onClick={() => setOpen(true)}><UserPlus size={16} /></button></Tip>
    {open && <ChatInviteDialog groupId={groupId} onClose={() => setOpen(false)} />}
  </>;
}
