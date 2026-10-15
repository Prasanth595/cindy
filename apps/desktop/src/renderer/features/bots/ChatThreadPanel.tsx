import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SendButton } from '@/components/new-chat/SendButton';
import { Button } from '@/components/ui/button';
import { Tip } from '@/components/ui/tooltip';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ShareSelectionBar } from '@/components/chat/ShareSelectionBar';
import { ShareMessageCheckbox } from '@/components/chat/ShareMessageCheckbox';
import { shareSelectionStore, useShareSelectionActive } from '@/components/chat/shareSelectionStore';
import { SHARE_SESSION_ATTR, SHARE_MESSAGE_ATTR } from '@/lib/shareConversationImage';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerPushCurrent } from '@/contexts/dataOwnerGeneration';
import type { BotGroupDetail, BotGroupExecutionFailureView, BotGroupMention, BotGroupMessageView } from '../../../shared/botGroupChat';
import { isBotGroupRuntimeFailureCode, resolveBotGroupQuote } from '../../../shared/botGroupChat';
import { refreshBotGroups } from './botGroupStore';
import { mergeBotGroupMessages, projectBotGroupExecutionFailures } from './botGroupPresentation';
import { BotAvatar } from './BotAvatar';
import { BotGroupQuoteBlock } from './BotGroupQuote';
import {
  BOT_GROUP_COMPOSER_CARD, BOT_GROUP_COMPOSER_COLUMN, BOT_GROUP_COMPOSER_DOCK, BOT_GROUP_COMPOSER_FOOTER, BOT_GROUP_COMPOSER_FOOTER_START, BOT_GROUP_COMPOSER_INPUT,
  fitBotGroupComposerInput, keepBotGroupComposerInputFocus, useRefitBotGroupComposerInputOnResize,
} from './botGroupComposerChrome';
import { BotGroupRuntimeFailureNotice } from './BotGroupRuntimeFailureNotice';
import { ChatMessageActions, chatErrorKey } from './ChatServerControls';
import { useBotGroupMentionPicker } from './useBotGroupMentionPicker';
const key = (name: string) => `bots.groupChat.server.${name}`;
const sameBotGroupMentions = (a: BotGroupMention, b: BotGroupMention) =>
  a.all === b.all && a.botIds.length === b.botIds.length && a.botIds.every((botId, index) => botId === b.botIds[index]);
const api = () => window.electronAPI.maker.chatServer;

export function animateThreadPanelWidth(panel: HTMLElement, from: string, to: string): Animation | null {
  const style = getComputedStyle(panel);
  const token = style.getPropertyValue('--motion-base').trim();
  const duration = parseFloat(token) * (token.endsWith('ms') ? 1 : 1000);
  if (!panel.animate || !Number.isFinite(duration) || duration <= 0) return null;
  return panel.animate([{ width: from }, { width: to }], {
    duration, easing: style.getPropertyValue('--motion-ease-move').trim() || 'linear', fill: 'forwards',
  });
}

function ThreadMessage({ group, message, quoteSources, shareScope, sharing, onChanged }: { group: BotGroupDetail; message: BotGroupMessageView; quoteSources: readonly BotGroupMessageView[]; shareScope: string; sharing: boolean; onChanged: () => void }) {
  const member = group.members.find(m => m.botId === message.authorBotId);
  if (message.kind === 'notice' && isBotGroupRuntimeFailureCode(message.runtimeFailureCode)) return <BotGroupRuntimeFailureNotice name={message.authorName || member?.name || ''} code={message.runtimeFailureCode} />;
  return <article {...{ [SHARE_SESSION_ATTR]: shareScope, [SHARE_MESSAGE_ATTR]: message.id }}
    className={`relative flex min-w-0 gap-2.5 ${sharing ? 'ml-10' : ''}`}>
    {sharing && <ShareMessageCheckbox clientId={message.id} />}
    <BotAvatar bot={{ name: message.authorName, avatar: member?.avatar ?? null, avatarUrl: member?.avatarUrl, avatarColor: member?.avatarColor ?? null }} size="sm" />
    <div className="min-w-0 flex-1 space-y-1">
      <p className="text-13 font-medium leading-7 text-[var(--text-primary)]">{message.authorName}</p>
      {/* A 话题 root may itself be a 引用回复; its original lives in the main timeline. */}
      {message.quote ? <BotGroupQuoteBlock display={resolveBotGroupQuote(message.quote, quoteSources)} /> : null}
      <div className="break-words text-14 leading-relaxed text-[var(--text-primary)]">
        <MarkdownRenderer workingDir="" content={message.content} allowPrivilegedLinks={false} />
      </div>
      <ChatMessageActions groupId={group.id} shareScope={shareScope} message={message} align="left" onChanged={onChanged} />
    </div>
  </article>;
}

/**
 * `quoteSources` are the main timeline's verified messages (older pages included), so a
 * 话题 root's quote reads the same as it does in the timeline; without them, the latest page.
 */
export function ChatThreadPanel({ group, rootId, quoteSources = group.messages, onClose }: { group: BotGroupDetail; rootId: string; quoteSources?: readonly BotGroupMessageView[]; onClose: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const shareScope = `bot-group:${group.id}:thread:${rootId}`;
  const sharing = useShareSelectionActive(shareScope);
  const contentRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const panel = panelRef.current;
    (panel?.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)') ?? panel?.querySelector<HTMLButtonElement>('header button'))?.focus();
  }, []);
  useEffect(() => {
    shareSelectionStore.exitIfNotSession(shareScope);
    return () => { if (shareSelectionStore.isActive(shareScope)) shareSelectionStore.exit(); };
  }, [shareScope]);
  const [root, setRoot] = useState<BotGroupMessageView | null>(null);
  const [executionFailures, setExecutionFailures] = useState<BotGroupExecutionFailureView[]>([]);
  const [replies, setReplies] = useState<BotGroupMessageView[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const attempt = useRef<{ text: string; roster: BotGroupDetail['members']; id: string; mentions: BotGroupMention } | null>(null);
  const sending = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const allLabel = t('bots.groupChat.mention.all');
  const allLabels = useMemo(() => [allLabel, '所有人', 'all', 'everyone'], [allLabel]);
  // Same @ picker as the main composer.
  const mention = useBotGroupMentionPicker({ text, members: group.members, textareaRef: inputRef, allLabels, onTextChange: value => {
    setText(value);
    if (attempt.current?.text !== value) attempt.current = null;
  } });
  useLayoutEffect(() => { if (inputRef.current) fitBotGroupComposerInput(inputRef.current); }, [text, sharing]);
  useRefitBotGroupComposerInputOnResize(inputRef, !sharing);
  const load = useCallback(async (before?: number) => {
    const version = ++request.current, owner = getDataOwnerGeneration();
    const current = () => version === request.current && isDataOwnerGenerationCurrent(owner);
    try {
      const result = await api().thread({ groupId: group.id, rootId, before, sourceMessageIds: replies.map(message => message.id) });
      if (!current()) return;
      if (!result.ok) { setError(t(chatErrorKey(result.errorCode))); return; }
      setRoot(result.root); setError('');
      setExecutionFailures(result.executionFailures ?? []);
      setReplies(previous => mergeBotGroupMessages(previous, result.replies));
      if (before || replies.length === 0) setHasMore(result.hasMore);
    } catch { if (current()) setError(t(key('requestFailed'))); }
  }, [group.id, rootId, t, replies]);
  const loadRef = useRef(load); loadRef.current = load;
  useEffect(() => {
    void loadRef.current();
    const stop = window.electronAPI.maker.onBotGroupChanged((event, stamp) => {
      if (isDataOwnerPushCurrent(stamp) && event.groupId === group.id) void loadRef.current();
    });
    return () => { request.current++; stop(); };
  }, [group.id, rootId]);
  async function send() {
    if (group.archived || sending.current || !text.trim()) return;
    sending.current = true; setBusy(true); setError('');
    const owner = getDataOwnerGeneration();
    // A retry reuses the attempt only for the same text and the same targets (bot-group-chat.md).
    // Targets are re-resolved against the attempt's own roster: a roster refresh alone changes nothing
    // and the host still rejects a departed target; re-picking someone else gets a new clientId.
    const previous = attempt.current;
    const current = previous && previous.text === text && sameBotGroupMentions(mention.resolve(text, previous.roster), previous.mentions)
      ? previous : { text, roster: group.members, id: crypto.randomUUID(), mentions: mention.resolve(text) };
    attempt.current = current;
    try {
      const result = await api().reply({ groupId: group.id, rootId, text: current.text, clientId: current.id,
        mentions: current.mentions });
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (!result.ok) { setError(t(chatErrorKey(result.errorCode))); return; }
      setText(''); mention.reset(); attempt.current = null; void loadRef.current(); refreshBotGroups();
    } catch { if (isDataOwnerGenerationCurrent(owner)) setError(t(key('requestFailed'))); }
    finally { sending.current = false; setBusy(false); }
  }
  return <aside ref={panelRef} aria-labelledby={titleId}
        className="flex h-full min-w-0 w-1/2 max-w-[min(50%,28rem)] shrink-0 flex-col overflow-hidden border-l border-[var(--border-default)] bg-[var(--surface)]">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-[var(--border-default)] px-5">
          <h2 id={titleId} className="text-15 font-medium text-[var(--text-primary)]">{t(key('topic'))}</h2>
          <Tip text={t('bots.close')}>
            <Button variant="secondary" tone="quiet" size="md"
              className="w-8 rounded-none px-0 [&::before]:rounded-full"
              aria-label={t('bots.close')} onClick={onClose}><X size={17} aria-hidden /></Button>
          </Tip>
        </header>
        <div ref={contentRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {projectBotGroupExecutionFailures(root ? [root] : [], executionFailures).map(message => <ThreadMessage key={message.id} quoteSources={quoteSources} shareScope={shareScope} sharing={sharing} group={group} message={message} onChanged={() => void loadRef.current()} />)}
          <div className="border-t border-[var(--border-default)] pt-3 text-12 text-[var(--text-tertiary)]">{t(key('replies'))}</div>
          {hasMore && <Button variant="secondary" size="sm" onClick={() => void loadRef.current(replies[0]?.sequence)}>{t('bots.groupChat.timeline.loadEarlier')}</Button>}
          {projectBotGroupExecutionFailures(replies, executionFailures).map(message => <ThreadMessage key={message.id} quoteSources={quoteSources} shareScope={shareScope} sharing={sharing} group={group} message={message} onChanged={() => void loadRef.current()} />)}
        </div>
        {sharing ? <ShareSelectionBar sessionId={shareScope} barWidth="100%"
          getContentWidth={() => contentRef.current?.querySelector('article')?.getBoundingClientRect().width ?? 400} /> : <div className={BOT_GROUP_COMPOSER_DOCK}><div className={BOT_GROUP_COMPOSER_COLUMN}>
          {error && <p role="alert" className="mb-2 px-1 text-13 leading-5 text-[var(--error-fg)]">{error}</p>}
          {/* Read-only also means no @ picks while sending. */}
          {busy ? null : mention.list}
          {/* Same card as the main group's composer; a sending reply stays read-only (and focused) until main answers. */}
          <div className={BOT_GROUP_COMPOSER_CARD} aria-busy={busy || undefined}>
            <textarea ref={inputRef} rows={1} aria-label={t(key('replyPlaceholder'))} placeholder={t(key('replyPlaceholder'))} value={text}
              {...mention.textareaProps} onChange={e => mention.onChange(e.target.value)}
              maxLength={8000} readOnly={busy} disabled={group.archived} className={BOT_GROUP_COMPOSER_INPUT} onKeyDown={e => {
                if (e.nativeEvent.isComposing || e.keyCode === 229 || (!busy && mention.onKeyDown(e))) return;
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
              }} />
            <div className={BOT_GROUP_COMPOSER_FOOTER}>
              {/* Send options for this reply go here, before the button. */}
              <div className={BOT_GROUP_COMPOSER_FOOTER_START} />
              <span className="inline-flex rounded-full" onMouseDown={keepBotGroupComposerInputFocus(inputRef)}>
                <Tip text={t(key('sendReply'))}>
                  <SendButton ariaLabel={t(key('sendReply'))} disabled={group.archived || busy || !text.trim()} onClick={() => void send()} />
                </Tip>
              </span>
            </div>
          </div>
        </div></div>}
  </aside>;
}
