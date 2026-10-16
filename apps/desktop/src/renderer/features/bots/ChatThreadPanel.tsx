import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Check, CornerDownRight, MessageSquareShare, X } from 'lucide-react';
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
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
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
import { BotGroupMessageAttachments } from './BotGroupMessageAttachments';
import { refreshPendingBotGroupAttachments } from './botGroupAttachments';
import { BotGroupRuntimeFailureNotice } from './BotGroupRuntimeFailureNotice';
import { BotGroupThreadShareQuote, botGroupThreadShareLabel, findThreadMessageElement, flashThreadTarget } from './BotGroupThreadViews';
import { ChatMessageActions, chatErrorKey, messageReactionRevision } from './ChatServerControls';
import { useBotGroupMentionPicker } from './useBotGroupMentionPicker';
const key = (name: string) => `bots.groupChat.server.${name}`;
const sameBotGroupMentions = (a: BotGroupMention, b: BotGroupMention) =>
  a.all === b.all && a.botIds.length === b.botIds.length && a.botIds.every((botId, index) => botId === b.botIds[index]);
const api = () => window.electronAPI.maker.chatServer;
/** Earlier pages read while looking for a reply opened from the main chat. */
const FOCUS_PAGE_LIMIT = 5;

/** Shares of this thread's replies that the main chat has loaded. */
export type BotGroupSharedReplies = ReadonlyMap<string, { messageId: string; bySelf: boolean }>;

/**
 * Replies that reached a thread while their main-chat copy did not, per group and thread.
 * Kept outside the panel, and the only copy: a copy may fail after its panel closed, or
 * while the same thread is open again, and either way that panel shows the retry.
 * Server groups keep their IDs across accounts, so the queue belongs to one data owner.
 */
const unpostedStore = { owner: getDataOwnerGeneration().dataOwnerId, replies: new Map<string, ReadonlySet<string>>(), listeners: new Set<() => void>() };
const NONE_UNPOSTED: ReadonlySet<string> = new Set();
function unpostedReplies() {
  // Same-account runtime repairs advance generation without changing this queue's owner.
  const owner = getDataOwnerGeneration().dataOwnerId;
  if (unpostedStore.owner !== owner) { unpostedStore.owner = owner; unpostedStore.replies.clear(); }
  return unpostedStore.replies;
}
function updateUnposted(key: string, update: (previous: ReadonlySet<string>) => ReadonlySet<string>) {
  const queue = unpostedReplies();
  const next = update(queue.get(key) ?? NONE_UNPOSTED);
  if (next.size) queue.set(key, next); else queue.delete(key);
  for (const listener of unpostedStore.listeners) listener();
}
function useUnposted(key: string): ReadonlySet<string> {
  return useSyncExternalStore(
    useCallback(listener => { unpostedStore.listeners.add(listener); return () => { unpostedStore.listeners.delete(listener); }; }, []),
    () => unpostedReplies().get(key) ?? NONE_UNPOSTED);
}

export function animateThreadPanelWidth(panel: HTMLElement, from: string, to: string): Animation | null {
  const style = getComputedStyle(panel);
  const token = style.getPropertyValue('--motion-base').trim();
  const duration = parseFloat(token) * (token.endsWith('ms') ? 1 : 1000);
  if (!panel.animate || !Number.isFinite(duration) || duration <= 0) return null;
  return panel.animate([{ width: from }, { width: to }], {
    duration, easing: style.getPropertyValue('--motion-ease-move').trim() || 'linear', fill: 'forwards',
  });
}

function ThreadMessage({ group, message, quoteSources, shareScope, sharing, shared, posting, onPost, onReveal, onChanged }: {
  group: BotGroupDetail; message: BotGroupMessageView; quoteSources: readonly BotGroupMessageView[]; shareScope: string; sharing: boolean;
  /** Replies only: already in the main chat (by anyone), and whether the reader shared it. */
  shared?: { bySelf: boolean } | null; posting?: boolean; onPost?: () => void; onReveal?: () => void; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const member = group.members.find(m => m.botId === message.authorBotId);
  if (message.kind === 'notice' && isBotGroupRuntimeFailureCode(message.runtimeFailureCode)) return <BotGroupRuntimeFailureNotice name={message.authorName || member?.name || ''} code={message.runtimeFailureCode} />;
  // A share as a thread root shows the same quote as the main chat, in every state.
  const share = message.threadShare;
  // Once the reader has posted it, posting again can only meet the same share: offer the
  // jump when that share can be located, and nothing otherwise.
  const postAction = !onPost || message.deleted || message.kind !== 'message' ? undefined
    : shared?.bySelf ? onReveal && { key: 'reveal-in-main', label: t(key('thread.viewInMain')), icon: <CornerDownRight size={14} strokeWidth={2} className="shrink-0" />, onSelect: onReveal }
    : { key: 'post-to-main', label: t(key('thread.postToMain')), disabled: posting, icon: <MessageSquareShare size={14} strokeWidth={2} className="shrink-0" />, onSelect: onPost };
  return <article {...{ [SHARE_SESSION_ATTR]: shareScope, [SHARE_MESSAGE_ATTR]: message.id }}
    className={`relative flex min-w-0 gap-2.5 ${sharing ? 'ml-10' : ''}`}>
    {sharing && <ShareMessageCheckbox clientId={message.id} />}
    <BotAvatar bot={{ name: message.authorName, avatar: member?.avatar ?? null, avatarUrl: member?.avatarUrl, avatarColor: member?.avatarColor ?? null }} size="sm" />
    <div className="min-w-0 flex-1 space-y-1">
      <p className="text-13 font-medium leading-7 text-[var(--text-primary)]">{message.authorName}</p>
      {/* A 话题 root may itself be a 引用回复; its original lives in the main timeline. */}
      {message.quote ? <BotGroupQuoteBlock display={resolveBotGroupQuote(message.quote, quoteSources)} /> : null}
      {share ? <>
        <p className="flex select-none items-center gap-1 text-12 text-[var(--text-tertiary)]">
          <CornerDownRight size={12} aria-hidden />{botGroupThreadShareLabel(share, t)}</p>
        <BotGroupThreadShareQuote share={share} members={group.members} attachments={<BotGroupMessageAttachments attachments={share.attachments} align="start" />} />
      </> : message.content.trim() ? <div className="break-words text-14 leading-relaxed text-[var(--text-primary)]">
        <MarkdownRenderer workingDir="" content={message.content} allowPrivilegedLinks={false} />
      </div> : null}
      {!share && <BotGroupMessageAttachments attachments={message.attachments} align="start" />}
      {shared && <button type="button" onClick={onReveal} disabled={!onReveal}
        className="-ml-1.5 inline-flex min-h-6 select-none items-center gap-1 rounded-full px-1.5 text-12 text-[var(--text-tertiary)] outline-none transition-colors duration-[var(--motion-fast)] enabled:hover:bg-[var(--surface-hover)] enabled:hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
        <CornerDownRight size={12} aria-hidden />{t(key(shared.bySelf ? 'thread.postedBySelf' : 'thread.postedToMain'))}
      </button>}
      <ChatMessageActions groupId={group.id} shareScope={shareScope} message={message} members={group.members} reactionRevision={messageReactionRevision(group, message.id)} align="left" onChanged={onChanged}
        copyText={share ? share.status === 'available' ? share.content : '' : undefined} menuActions={postAction ? [postAction] : undefined} />
    </div>
  </article>;
}

/**
 * `quoteSources` are the main timeline's verified messages (older pages included), so a
 * 话题 root's quote reads the same as it does in the timeline; without them, the latest page.
 */
export function ChatThreadPanel({ group, rootId, quoteSources = group.messages, focus, sharedReplies, onRevealShare, onClose }: {
  group: BotGroupDetail; rootId: string; quoteSources?: readonly BotGroupMessageView[];
  /** A reply to bring into view; a new nonce repeats the jump. */
  focus?: { messageId: string; nonce: number } | null;
  sharedReplies?: BotGroupSharedReplies;
  /** Scroll the main chat to a share; false when it is not loaded there. */
  onRevealShare?: (messageId: string) => boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const shareScope = `bot-group:${group.id}:thread:${rootId}`;
  const sharing = useShareSelectionActive(shareScope);
  const readOnly = Boolean(group.archived || group.dissolvedAt);
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
  // Off by default: a reply stays in the thread unless the user asks for both.
  const [alsoSend, setAlsoSend] = useState(false);
  const unpostedKey = `${group.id}:${rootId}`;
  const unposted = useUnposted(unpostedKey);
  const setUnposted = (update: (previous: ReadonlySet<string>) => ReadonlySet<string>) => updateUnposted(unpostedKey, update);
  const [posting, setPosting] = useState<ReadonlySet<string>>(new Set());
  const postingRef = useRef(new Set<string>());
  /** Shares confirmed in this panel (reply → main-chat message, null when unknown). */
  const [posted, setPosted] = useState<ReadonlyMap<string, string | null>>(new Map());
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
  /** `onAccepted` runs only when this read's result is the one shown. */
  const load = useCallback(async (before?: number, onAccepted?: () => void) => {
    const version = ++request.current, owner = getDataOwnerGeneration();
    const current = () => version === request.current && isDataOwnerGenerationCurrent(owner);
    try {
      const result = await api().thread({ groupId: group.id, rootId, before, sourceMessageIds: replies.map(message => message.id) });
      if (!current()) return;
      if (!result.ok) { setError(t(chatErrorKey(result.errorCode))); return; }
      onAccepted?.();
      setRoot(result.root); setError('');
      setExecutionFailures(result.executionFailures ?? []);
      setReplies(previous => mergeBotGroupMessages(previous, result.replies));
      if (before || replies.length === 0) setHasMore(result.hasMore);
      if (before === undefined && result.replies.length > 0) {
        const latestFrom = Math.min(...result.replies.map(message => message.sequence));
        const refreshed = await refreshPendingBotGroupAttachments(replies, latestFrom, async page => {
          const earlier = await api().thread({ groupId: group.id, rootId, before: page });
          return earlier.ok && current() ? earlier.replies : null;
        });
        if (refreshed && current()) {
          const fresh = new Map(refreshed.map(message => [message.sequence, message]));
          setReplies(previous => previous.map(message => message.sequence < latestFrom ? fresh.get(message.sequence) ?? message : message));
        }
      }
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
  // A share opened this thread: find its reply, reading back a few pages if needed.
  const focusSearch = useRef<{ nonce: number; pages: number } | null>(null);
  useEffect(() => {
    if (!focus || !replies.length) return;
    if (focusSearch.current?.nonce !== focus.nonce) focusSearch.current = { nonce: focus.nonce, pages: 0 };
    const search = focusSearch.current;
    if (search.pages < 0) return;
    const target = findThreadMessageElement(contentRef.current, focus.messageId);
    if (target) { search.pages = -1; flashThreadTarget(target); return; }
    if (!hasMore || search.pages >= FOCUS_PAGE_LIMIT) { search.pages = -1; return; }
    // A push refresh may overtake this page; then its replies trigger the next attempt, and
    // only a page that was merged counts against the limit.
    void loadRef.current(replies[0]?.sequence, () => { search.pages += 1; });
  }, [focus, replies, hasMore]);

  /** One server operation per reply and person, so a retry never posts twice. */
  async function postToMain(messageId: string, fromComposer: boolean) {
    if (readOnly || postingRef.current.has(messageId)) return false;
    postingRef.current.add(messageId); setPosting(new Set(postingRef.current));
    const owner = getDataOwnerGeneration();
    const failed = (code?: string) => {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      if (code === 'SHARE_UNAVAILABLE') {
        setUnposted(previous => { const next = new Set(previous); next.delete(messageId); return next; });
        toast.error(t(chatErrorKey(code)));
      } else if (fromComposer) setUnposted(previous => new Set(previous).add(messageId));
      else toast.error(t(code ? chatErrorKey(code) : key('requestFailed')));
    };
    try {
      const result = await api().shareToMain({ groupId: group.id, messageId });
      if (!isDataOwnerGenerationCurrent(owner)) return false;
      if (!result.ok) { failed(result.errorCode); return false; }
      setPosted(previous => new Map(previous).set(messageId, result.messageId));
      setUnposted(previous => { const next = new Set(previous); next.delete(messageId); return next; });
      if (result.alreadyShared && !fromComposer) toast.info(t(key('thread.alreadyPosted')));
      refreshBotGroups();
      return true;
    } catch { failed(); return false; }
    finally { postingRef.current.delete(messageId); setPosting(new Set(postingRef.current)); }
  }
  async function retryUnposted() {
    // The queue belongs to the account that started the retry; stop once it is switched.
    const owner = getDataOwnerGeneration();
    for (const messageId of unposted) {
      if (!isDataOwnerGenerationCurrent(owner)) return;
      await postToMain(messageId, true);
    }
  }
  async function send() {
    if (readOnly || sending.current || !text.trim()) return;
    sending.current = true; setBusy(true); setError('');
    const owner = getDataOwnerGeneration();
    const toMain = alsoSend;
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
      // The reply exists now; only its main-chat copy may still need a retry.
      setText(''); mention.reset(); attempt.current = null; setAlsoSend(false);
      if (toMain) await postToMain(result.messageId, true);
      void loadRef.current(); refreshBotGroups();
    } catch { if (isDataOwnerGenerationCurrent(owner)) setError(t(key('requestFailed'))); }
    finally { sending.current = false; setBusy(false); }
  }
  /** The reader's own share wins over another member's, even when only this panel knows it. */
  const sharedState = (messageId: string) => {
    const known = sharedReplies?.get(messageId);
    if (known?.bySelf) return { bySelf: true, shareId: known.messageId };
    if (posted.has(messageId)) return { bySelf: true, shareId: posted.get(messageId) ?? null };
    return known ? { bySelf: false, shareId: known.messageId } : null;
  };
  /** The share may sit on an older page the main chat has not loaded. */
  const revealShare = (shareId: string) => {
    if (!onRevealShare?.(shareId)) toast.info(t(key('thread.shareNotLoaded')));
  };
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
          {projectBotGroupExecutionFailures(root ? [root] : [], executionFailures).map(message => <ThreadMessage key={message.id} quoteSources={quoteSources} shareScope={shareScope} sharing={sharing} group={group} message={message}
            onChanged={() => void loadRef.current()} />)}
          <div className="border-t border-[var(--border-default)] pt-3 text-12 text-[var(--text-tertiary)]">{t(key('replies'))}</div>
          {hasMore && <Button variant="secondary" size="sm" onClick={() => void loadRef.current(replies[0]?.sequence)}>{t('bots.groupChat.timeline.loadEarlier')}</Button>}
          {projectBotGroupExecutionFailures(replies, executionFailures).map(message => {
            const shared = sharedState(message.id);
            return <ThreadMessage key={message.id} quoteSources={quoteSources} shareScope={shareScope} sharing={sharing} group={group} message={message}
              shared={shared} posting={posting.has(message.id)}
              onPost={readOnly ? undefined : () => void postToMain(message.id, false)}
              onReveal={shared?.shareId ? () => revealShare(shared.shareId!) : undefined}
              onChanged={() => void loadRef.current()} />;
          })}
        </div>
        {sharing ? <ShareSelectionBar sessionId={shareScope} barWidth="100%"
          getContentWidth={() => contentRef.current?.querySelector('article')?.getBoundingClientRect().width ?? 400} /> : <div className={BOT_GROUP_COMPOSER_DOCK}><div className={BOT_GROUP_COMPOSER_COLUMN}>
          {error && <p role="alert" className="mb-2 px-1 text-13 leading-5 text-[var(--error-fg)]">{error}</p>}
          {/* Kept apart from read errors: a thread refresh must not hide the retry. */}
          {unposted.size > 0 && <div role="alert" className="mb-2 px-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-13 text-[var(--error-fg)]">
            <span className="min-w-0">{t(key('thread.alsoSendFailed'), { count: unposted.size })}</span>
            <Button variant="secondary" size="sm" compact disabled={readOnly} loading={[...unposted].some(id => posting.has(id))} onClick={() => void retryUnposted()}>
              {t(key('thread.retryPost'))}</Button>
          </div>}
          {/* Read-only also means no @ picks while sending. */}
          {busy || readOnly ? null : mention.list}
          {/* Same card as the main group's composer; a sending reply stays read-only (and focused) until main answers. */}
          <div className={BOT_GROUP_COMPOSER_CARD} aria-busy={busy || undefined}>
            <textarea ref={inputRef} rows={1} aria-label={t(key('replyPlaceholder'))} placeholder={t(key('replyPlaceholder'))} value={text}
              {...mention.textareaProps} onChange={e => mention.onChange(e.target.value)}
              maxLength={8000} readOnly={busy} disabled={readOnly} className={BOT_GROUP_COMPOSER_INPUT} onKeyDown={e => {
                if (e.nativeEvent.isComposing || e.keyCode === 229 || (!busy && mention.onKeyDown(e))) return;
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
              }} />
            <div className={BOT_GROUP_COMPOSER_FOOTER}>
              <div className={BOT_GROUP_COMPOSER_FOOTER_START}>
                <button type="button" role="checkbox" aria-checked={alsoSend} disabled={busy || readOnly}
                  onClick={() => setAlsoSend(value => !value)}
                  className="-ml-1.5 inline-flex min-h-7 min-w-0 select-none items-center gap-2 rounded-full px-1.5 text-13 text-[var(--text-secondary)] outline-none transition-colors duration-[var(--motion-fast)] enabled:hover:bg-[var(--surface-hover)] enabled:hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] disabled:opacity-50">
                  <span aria-hidden className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors duration-[var(--motion-fast)]',
                    alsoSend ? 'bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]' : 'border border-[var(--border-default)]')}>
                    {alsoSend ? <Check size={10} strokeWidth={3} /> : null}
                  </span>
                  <span className="min-w-0 truncate">{t(key('thread.alsoSend'))}</span>
                </button>
              </div>
              <span className="inline-flex rounded-full" onMouseDown={keepBotGroupComposerInputFocus(inputRef)}>
                <Tip text={t(key('sendReply'))}>
                  <SendButton ariaLabel={t(key('sendReply'))} disabled={readOnly || busy || !text.trim()} onClick={() => void send()} />
                </Tip>
              </span>
            </div>
          </div>
        </div></div>}
  </aside>;
}
