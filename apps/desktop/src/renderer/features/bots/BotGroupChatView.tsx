import { RemoveChatFromListButton } from './RemoveChatFromListButton';
import type { ReactNode } from 'react';
/**
 * 群聊页：顶栏（成员头像、群名、成员名单、群设置入口）+ 多作者时间线 + 输入框。
 *
 * 数据全部来自 main（docs/product-rules/bot-group-chat.md §3）：进入时读一页最新消息，
 * 之后每条 `onBotGroupChanged` 推送（含分工的 `'plan'`）都整页重读，renderer 不自己拼
 * 时间线。加载沿用 BotDirectMessageView 的新鲜度护栏：请求代次 + data owner 代次 + 推送
 * owner 戳，过期响应一律丢弃。更早的消息按需翻页，连同其引用的安排合并进当前时间线。
 *
 * 分工（§7）：安排卡、交接文件与「下一步 · 继续」「没做完 · 重试」见 BotGroupPlan.tsx；
 * 这里只负责把安排快照接到对应消息上，并调用 main 的安排操作。
 *
 * 引用回复（§10）：页面持有本群的待发引用（随群切换整页重建，不会串群）；已发消息上的
 * 引用块以已加载的原消息为准，点击跳到原消息并高亮，原消息不在已加载范围时向前翻几页找。
 *
 * 附件（§3.1）：托盘状态（`useAttachments`）由页面持有，文件拖到页面任意位置都进托盘，
 * 与普通任务的整区拖入一致；用户消息上的图片与文件复用普通聊天用户气泡的图片视图与
 * 附件 chip。
 *
 * 自己刚发的消息先由发件箱（botGroupOutbox.ts）接在时间线末尾显示，main 读到它后由
 * 真实消息替换；没发出去的显示「没发出去」与重试、编辑。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ArrowLeft, CircleAlert, CornerDownRight, RefreshCcw, Settings2, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useParams } from 'react-router-dom';

import { attachGhostMediaToSession, getGhostMediaHandoverFromDataTransfer } from '@/cindy-brain/ghostMediaHandover';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { ShareSelectionBar } from '@/components/chat/ShareSelectionBar';
import { ShareMessageCheckbox } from '@/components/chat/ShareMessageCheckbox';
import { shareSelectionStore, useShareSelectionActive } from '@/components/chat/shareSelectionStore';
import { SHARE_SESSION_ATTR, SHARE_MESSAGE_ATTR } from '@/lib/shareConversationImage';
import { CHAT_BODY_CLASS } from '@/components/chat/chatChrome';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import { useAttachments } from '@/hooks/useAttachments';
import { discardDraft } from '@/lib/composerDraftStore';
import {
  classifyUnclassifiedDroppedItems,
  getDroppedFileItems,
  type DroppedFileItems,
} from '@/lib/fileDrop';
import { isGlobalDropIntercepted } from '@/lib/globalDropIntercept';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { ControlledBanner, useControlledBy, useComposerCollapsed } from '@/features/remote-device/ControlledBanner';
import { useAgentIslandActivity } from '@/state/agentIslandActivity';
import type {
  BotGroupAttachment,
  BotGroupDetail,
  BotGroupMemberView,
  BotGroupMessageView,
  BotGroupPlanAction,
  BotGroupPlanStepView,
  BotGroupPlanView,
  BotGroupQuoteDisplay,
  BotGroupQuoteView,
  BotGroupSpeakerActivity,
} from '../../../shared/botGroupChat';
import { botGroupQuoteFromMessage, isBotGroupMessageQuotable, resolveBotGroupQuote } from '../../../shared/botGroupChat';
import { useRegisterContentHeader } from '../feature-context';
import { BotAvatar } from './BotAvatar';
import { BotGenerationLabel } from './BotGenerationLabel';
import { BotGroupAvatarStack } from './BotGroupAvatars';
import { botGroupAttachmentScope, refreshPendingBotGroupAttachments } from './botGroupAttachments';
import { BotGroupMessageAttachments } from './BotGroupMessageAttachments';
import { BotGroupComposer } from './BotGroupComposer';
import { BotGroupQuoteBlock } from './BotGroupQuote';
import { ChatInviteButton, ChatMessageActions, messageReactionRevision } from './ChatServerControls';
import { animateThreadPanelWidth, ChatThreadPanel } from './ChatThreadPanel';
import { BotGroupThreadPreview, BotGroupThreadShareQuote, botGroupThreadShareLabel, findThreadMessageElement, flashThreadTarget } from './BotGroupThreadViews';
import { BotGroupPendingInteraction } from './BotGroupPendingInteraction';
import { BotGroupRuntimeFailureNotice } from './BotGroupRuntimeFailureNotice';
import { isBotGroupRuntimeFailureCode } from '../../../shared/botGroupChat';
import {
  BotGroupHandoffFiles,
  BotGroupOrganizerTag,
  BotGroupPlanCard,
  BotGroupPlanEndDivider,
  BotGroupPlanFollowUpRow,
  type BotGroupFollowUpAction,
  type BotGroupPlanCardAction,
} from './BotGroupPlan';
import { splitBotGroupMentionSegments } from './botGroupMentions';
import {
  BOT_GROUP_SETTINGS_PARAM,
  botGroupComposerPlanState,
  botGroupErrorKey,
  botGroupMemberNames,
  botGroupNoticeKey,
  botGroupPlanFollowUp,
  continuableRoundEndId,
  mergeBotGroupMessages,
  projectBotGroupExecutionFailures,
  mergeBotGroupPlans,
  openBotGroupPlan,
} from './botGroupPresentation';
import { botGroupApi, editBotGroupPlanStep, runBotGroupPlanAction, useBotGroupSummary } from './botGroupStore';
import {
  beginBotGroupTimelineRead,
  discardBotGroupOutbox,
  editBotGroupSend,
  getBotGroupOutboxClaims,
  getBotGroupOutboxPreviews,
  interleaveBotGroupOutbox,
  mergeBotGroupLocalAttachments,
  noteBotGroupTimeline,
  projectBotGroupOutbox,
  retryBotGroupSend,
  useBotGroupOutbox,
  type BotGroupOutboxEntry,
} from './botGroupOutbox';
import { botGroupReadKey, markBotRead } from './botReadState';
import { collectBotMessageTimeGroups, formatBotMessageGroupTime } from './botConversationTimeline';

type GroupViewState =
  | { kind: 'loading' }
  | {
      kind: 'ready';
      group: BotGroupDetail;
      /** Pages loaded through 「查看更早的消息」, merged under the latest page. */
      older: BotGroupMessageView[];
      /** Plans referenced by the older pages; the latest read wins on overlap. */
      olderPlans: BotGroupPlanView[];
      olderHasMore: boolean;
      /** Outbox read token of the read that produced `group` (see beginBotGroupTimelineRead). */
      readToken: number;
    }
  | { kind: 'missing' }
  | { kind: 'error' };

/** Toast copy when a plan action fails without a more specific cause. */
const PLAN_ACTION_FAILED: Record<BotGroupPlanAction, string> = {
  start: 'bots.groupChat.plan.startFailed',
  dismiss: 'bots.groupChat.plan.dismissFailed',
  continue: 'bots.groupChat.timeline.continuePlanFailed',
  retry: 'bots.groupChat.timeline.retryFailed',
};

type PlanPending = { planId: string; action: BotGroupPlanAction | 'edit' };

/** A read that lands within this needs no progress indicator, so a fast switch does not flash. */
const TIMELINE_LOADING_REVEAL_MS = 200;
/** Older pages read while looking for a quoted message before saying it is out of reach. */
const QUOTE_LOCATE_MAX_PAGES = 5;
const QUOTE_HIGHLIGHT_MS = 2000;
const NO_IDS: ReadonlySet<string> = new Set();

/**
 * Originals that loaded quotes point at and that sit only on older pages, newest first. A push
 * refresh re-reads just the latest page, so these may have been edited or deleted since.
 */
function quotedOlderOriginals(
  older: readonly BotGroupMessageView[],
  latest: readonly BotGroupMessageView[],
): BotGroupMessageView[] {
  const latestIds = new Set(latest.map((message) => message.id));
  const olderById = new Map(older.map((message) => [message.id, message]));
  const ids = new Set([...older, ...latest].flatMap((message) => {
    const target = message.quote?.messageId;
    return target && !latestIds.has(target) && olderById.has(target) ? [target] : [];
  }));
  return [...ids].map((id) => olderById.get(id)!).sort((a, b) => b.sequence - a.sequence);
}

/** Stable identity for header memoization; member arrays are new on every read. */
function memberKey(members: readonly BotGroupMemberView[]): string {
  return JSON.stringify(members.map((member) => [member.botId, member.name, member.avatar, member.avatarColor]));
}

/**
 * Files from the system or media dragged out of a Plugin panel. Plain text keeps its
 * native drop into the input.
 */
function isAttachmentDrag(event: DragEvent): boolean {
  const types = Array.from(event.dataTransfer.types);
  return types.includes('Files') || types.includes('text/uri-list');
}

export function BotGroupChatView() {
  const { groupId } = useParams();
  return <BotGroupChatContent key={groupId ?? ''} groupId={groupId ?? ''} />;
}

function BotGroupChatContent({ groupId }: { groupId: string }) {
  const { t, i18n } = useTranslation();
  const controlledBy = useControlledBy();
  const hasControlledBanner = controlledBy.length > 0;
  // Groups have no single task session; namespace their existing composer UI state.
  const controlledBannerKey = `bot-group:${groupId}`;
  const shareScope = controlledBannerKey;
  const sharing = useShareSelectionActive(shareScope);
  useEffect(() => {
    shareSelectionStore.exitIfNotSession(shareScope);
    return () => { if (shareSelectionStore.isActive(shareScope)) shareSelectionStore.exit(); };
  }, [shareScope]);
  const controlledBannerCollapsed = useComposerCollapsed(controlledBannerKey);
  const navigate = useNavigate();
  const location = useLocation();
  const [state, setState] = useState<GroupViewState>({ kind: 'loading' });
  const stateRef = useRef(state); stateRef.current = state;
  const [reloadVersion, setReloadVersion] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [continuing, setContinuing] = useState(false);
  const [planPending, setPlanPending] = useState<PlanPending | null>(null);
  const planPendingRef = useRef(false);
  const loadRef = useRef<(additionalSources?: string[]) => void>(() => {});
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const readOwner = useRef(getDataOwnerGeneration());
  const prependAnchorRef = useRef<{ height: number; top: number } | null>(null);
  const attachmentScope = botGroupAttachmentScope(groupId);
  const attachmentState = useAttachments(attachmentScope, attachmentScope);
  const [dragOver, setDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  /** 引用回复 waiting in this group's composer; the page is rebuilt per group. */
  const [quoteDraft, setQuoteDraft] = useState<BotGroupQuoteView | null>(null);
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  /** Quoted originals on older pages not re-read since the last push: quotes use their snapshot. */
  const [unverifiedOriginals, setUnverifiedOriginals] = useState<ReadonlySet<string>>(NO_IDS);
  const loadingOlderRef = useRef(false);
  const locatingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let requestVersion = 0;
    // The composer queues under the group's own id, which an older local route may not match.
    const discardOutbox = () => {
      const shown = stateRef.current;
      discardBotGroupOutbox(groupId);
      if (shown.kind === 'ready' && shown.group.id !== groupId) discardBotGroupOutbox(shown.group.id);
    };
    const load = async (additionalSources: string[] = []) => {
      const version = ++requestVersion;
      const owner = getDataOwnerGeneration();
      const api = botGroupApi();
      const isCurrent = () =>
        !cancelled && version === requestVersion && isDataOwnerGenerationCurrent(owner);
      if (!api || !groupId) {
        if (isCurrent()) setState({ kind: groupId ? 'error' : 'missing' });
        return;
      }
      const readToken = beginBotGroupTimelineRead();
      try {
        const displayed = stateRef.current;
        const shown = displayed.kind === 'ready' && displayed.group.id === groupId;
        const sourceMessageIds = [...new Set([...(shown
          ? mergeBotGroupMessages(displayed.older, displayed.group.messages).map(message => message.id) : []), ...additionalSources])];
        // Older pages are not re-read, so their shares ask for the reply's current state.
        const shownShares = shown ? botGroupShownShares(displayed.older) : [];
        const result = sourceMessageIds.length || shownShares.length
          ? await api.getBotGroup(groupId, { sourceMessageIds, ...(shownShares.length ? { shownShares } : {}) })
          : await api.getBotGroup(groupId);
        if (!isCurrent()) return;
        if (result.ok) {
          readOwner.current = owner;
          setState((previous) =>
            previous.kind === 'ready'
              ? { ...previous, group: result.group, older: applyBotGroupThreadShareUpdates(previous.older, result.group), readToken }
              : {
                  kind: 'ready',
                  group: result.group,
                  older: [],
                  olderPlans: [],
                  olderHasMore: result.group.hasMoreBefore,
                  readToken,
                },
          );
          const shown = stateRef.current;
          if (shown.kind === 'ready') {
            const targets = quotedOlderOriginals(shown.older, result.group.messages);
            if (targets.length > 0) void recheckQuotedOriginals(api, targets, isCurrent);
          }
          if (displayed.kind === 'ready' && displayed.group.id === groupId && result.group.messages.length > 0) {
            const latestFrom = Math.min(...result.group.messages.map((message) => message.sequence));
            const refreshed = await refreshPendingBotGroupAttachments(displayed.older, latestFrom, async (before) => {
              const page = await api.getBotGroup(groupId, { beforeSequence: before });
              return page.ok && isCurrent() ? page.group.messages : null;
            });
            if (refreshed && isCurrent()) {
              const fresh = new Map(refreshed.map((message) => [message.sequence, message]));
              setState((previous) => previous.kind === 'ready' && previous.group.id === groupId
                ? { ...previous, older: previous.older.map((message) => fresh.get(message.sequence) ?? message) }
                : previous);
            }
          }
        } else if (result.errorCode === 'NOT_FOUND') {
          // Gone for this account (deleted, archived or left): nothing of it is left to send.
          discardOutbox();
          setState({ kind: 'missing' });
        } else {
          // Keep a timeline that is already on screen; only a first read fails loudly.
          setState((previous) => (previous.kind === 'ready' ? previous : { kind: 'error' }));
        }
      } catch {
        if (isCurrent()) setState((previous) => (previous.kind === 'ready' ? previous : { kind: 'error' }));
      }
    };
    /**
     * Re-reads the older pages holding quoted originals after a push and updates only messages
     * already loaded; history that was never opened is not fetched. Each read covers at least the
     * newest remaining original, so it ends after at most one read per original. A newer read
     * supersedes this one; a failed read leaves the rest unverified, so their quotes show the
     * snapshot, not the stale copy.
     */
    const recheckQuotedOriginals = async (
      api: NonNullable<ReturnType<typeof botGroupApi>>,
      targets: BotGroupMessageView[],
      isCurrent: () => boolean,
    ) => {
      setUnverifiedOriginals((previous) => new Set([...previous, ...targets.map((target) => target.id)]));
      let remaining = targets;
      for (let page = 0; remaining.length > 0 && page < targets.length; page += 1) {
        let messages: BotGroupMessageView[] | null = null;
        try {
          const read = await api.getBotGroup(groupId, { beforeSequence: remaining[0]!.sequence + 1 });
          messages = read.ok ? read.group.messages : null;
        } catch {
          messages = null;
        }
        if (!isCurrent() || !messages) return;
        const fresh = new Map(messages.map((message) => [message.id, message]));
        const oldest = messages.reduce((min, message) => Math.min(min, message.sequence), Number.POSITIVE_INFINITY);
        const covered = remaining.filter((target) => fresh.has(target.id) || target.sequence >= oldest);
        setState((previous) => previous.kind === 'ready'
          ? { ...previous, older: previous.older.map((message) => fresh.get(message.id) ?? message) }
          : previous);
        // An original missing from a page that covers it is no longer readable here: it stays unverified.
        setUnverifiedOriginals((previous) => {
          const next = new Set(previous);
          for (const target of covered) if (fresh.has(target.id)) next.delete(target.id);
          return next;
        });
        remaining = remaining.filter((target) => !covered.includes(target));
        if (covered.length === 0) return;
      }
    };
    loadRef.current = additionalSources => void load(additionalSources);
    void load();
    const unsubscribe =
      botGroupApi()?.onBotGroupChanged?.((payload, ownerStamp) => {
        if (cancelled || !isDataOwnerPushCurrent(ownerStamp) || payload.groupId !== groupId) return;
        if (payload.change === 'deleted' || (payload.change === 'list' && payload.listState?.hidden)) {
          requestVersion += 1;
          // Unsent attachments go with the group (staged copies included).
          discardDraft(botGroupAttachmentScope(groupId));
          discardOutbox();
          setState({ kind: 'missing' });
          // The authoritative hide can unmount the drawer before its IPC reply.
          // This mounted page owns selection, so clear the route here as well.
          if (payload.change === 'list') navigate('/bots');
          return;
        }
        void load();
      }) ?? (() => {});
    return () => {
      cancelled = true;
      requestVersion += 1;
      loadRef.current = () => {};
      unsubscribe();
    };
  }, [groupId, reloadVersion, navigate]);

  // An older page may land across a refresh. Recheck that set once per version; source
  // and attachment completion pushes then refresh every displayed share together.
  // The derived key stays unchanged if a read cannot confirm a source, avoiding a loop.
  const staleSharesKey = state.kind === 'ready' && staleBotGroupShares(state.older, state.group.threadShareVersion).length
    ? JSON.stringify([state.group.threadShareVersion, staleBotGroupShares(state.older, state.group.threadShareVersion).map(message => message.id)]) : '';
  useEffect(() => {
    if (staleSharesKey) loadRef.current();
  }, [staleSharesKey]);

  const group = state.kind === 'ready' ? state.group : null;
  // Until the timeline arrives, the header comes from the group's sidebar row (same account).
  const listed = useBotGroupSummary(state.kind === 'loading' || state.kind === 'error' ? groupId : null);
  const headerGroup = group ?? listed;
  const messages = useMemo(
    () => (state.kind === 'ready' ? projectBotGroupExecutionFailures(mergeBotGroupMessages(state.older, state.group.messages), state.group.executionFailures) : []),
    [state],
  );
  /** Thread replies already in the loaded main chat, with the share to reveal. */
  const sharedReplies = useMemo(() => {
    const shares = new Map<string, { messageId: string; bySelf: boolean }>();
    for (const message of messages) {
      const share = message.threadShare;
      // Only a share the server resolved inside its claimed thread stands for that reply.
      if (share?.status !== 'available') continue;
      const bySelf = message.authorKind === 'user' && message.isSelf !== false;
      // Prefer the reader's own share: it is the one a repeat would return.
      if (!shares.has(share.messageId) || bySelf) shares.set(share.messageId, { messageId: message.id, bySelf });
    }
    return shares;
  }, [messages]);
  // The composer sends under the group's own id; an older local route can still lead here.
  const outboxGroupId = group?.id ?? groupId;
  const outbox = useBotGroupOutbox(outboxGroupId);
  // Settle receipts only once the read that shows them is on screen, so a pending bubble
  // never disappears a frame before its real message appears. Older pages count too: a
  // message pushed off the latest page settles its previews once 查看更早的消息 shows it.
  // A receipt for a message the timeline already shows settles when it comes back.
  useLayoutEffect(() => {
    if (state.kind === 'ready') noteBotGroupTimeline(outboxGroupId, mergeBotGroupMessages(state.older, state.group.messages), state.readToken);
  }, [outboxGroupId, state, outbox]);
  const { pending: pendingSends, localAttachments } = useMemo(
    () => projectBotGroupOutbox(outbox, messages, getBotGroupOutboxClaims(outboxGroupId), getBotGroupOutboxPreviews(outboxGroupId)),
    [outboxGroupId, messages, outbox],
  );
  // A receipt the timeline does not show yet: read again so the real message takes its place.
  const unreadReceipts = pendingSends.flatMap((entry) => (entry.status === 'sent' && entry.messageId ? [entry.messageId] : [])).join(',');
  useEffect(() => {
    if (unreadReceipts) loadRef.current();
  }, [unreadReceipts]);
  // Quotes resolve against verified copies only; an unverified original falls back to the snapshot.
  const quoteSources = useMemo(
    () => (unverifiedOriginals.size > 0 ? messages.filter((message) => !unverifiedOriginals.has(message.id)) : messages),
    [messages, unverifiedOriginals],
  );
  const acknowledge = useCallback(() => {
    if (!isDataOwnerGenerationCurrent(readOwner.current) || !stickToBottomRef.current || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    const at = messages.reduce((latest, message) => message.kind === 'message' && (message.authorKind === 'bot' || message.isSelf === false)
      ? Math.max(latest, message.createdAt) : latest, 0);
    if (at > 0) markBotRead(botGroupReadKey(groupId), at);
  }, [groupId, messages]);
  useEffect(() => {
    const frame = requestAnimationFrame(acknowledge);
    window.addEventListener('focus', acknowledge);
    document.addEventListener('visibilitychange', acknowledge);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('focus', acknowledge); document.removeEventListener('visibilitychange', acknowledge); };
  }, [acknowledge]);
  const plans = useMemo(
    () => (state.kind === 'ready' ? mergeBotGroupPlans(state.olderPlans, state.group.plans) : []),
    [state],
  );
  const hasMoreBefore =
    state.kind === 'ready' && (state.older.length > 0 ? state.olderHasMore : state.group.hasMoreBefore);

  const openSettings = useCallback(() => {
    const search = new URLSearchParams(location.search);
    search.set(BOT_GROUP_SETTINGS_PARAM, '1');
    navigate(`${location.pathname}?${search.toString()}`);
  }, [location.pathname, location.search, navigate]);

  const separator = t('bots.groupChat.memberSeparator');
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  /** A reply to bring into view when a main-chat share opens its thread. */
  const [threadFocus, setThreadFocus] = useState<{ messageId: string; nonce: number } | null>(null);
  const threadOpenerRef = useRef<HTMLElement | null>(null);
  const threadLayoutRef = useRef<HTMLDivElement>(null);
  const threadHeaderRef = useRef<HTMLDivElement>(null);
  const threadCloseAnimationRef = useRef<Animation | null>(null);
  const threadWasOpenRef = useRef(false);
  useLayoutEffect(() => {
    const opening = !!threadRootId && !threadWasOpenRef.current;
    threadWasOpenRef.current = !!threadRootId;
    if (!opening) return;
    const panel = threadLayoutRef.current?.querySelector('aside');
    const animation = panel && animateThreadPanelWidth(panel, '0px', '50%');
    if (!animation) return;
    void animation.finished.then(() => animation.cancel(), () => {});
    return () => animation.cancel();
  }, [threadRootId]);
  const closeThread = useCallback(() => {
    if (threadCloseAnimationRef.current) return;
    const panel = threadLayoutRef.current?.querySelector('aside');
    const animation = panel && animateThreadPanelWidth(panel, `${panel.getBoundingClientRect().width}px`, '0px');
    threadOpenerRef.current?.focus();
    if (!panel || !animation) { setThreadRootId(null); return; }
    panel.inert = true;
    threadCloseAnimationRef.current = animation;
    void animation.finished.then(() => {
      if (threadCloseAnimationRef.current !== animation) return;
      threadCloseAnimationRef.current = null;
      setThreadRootId(null);
    }, () => {});
  }, []);
  useLayoutEffect(() => () => {
    threadCloseAnimationRef.current?.cancel();
    threadCloseAnimationRef.current = null;
  }, [threadRootId]);
  const openThread = useCallback((rootId: string, focusMessageId?: string) => {
    threadOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (threadCloseAnimationRef.current) {
      threadCloseAnimationRef.current.cancel();
      threadCloseAnimationRef.current = null;
      const panel = threadLayoutRef.current?.querySelector('aside');
      if (panel) panel.inert = false;
      if (rootId === threadRootId) {
        (panel?.querySelector<HTMLTextAreaElement>('textarea:not(:disabled)') ?? panel?.querySelector<HTMLButtonElement>('header button'))?.focus();
      }
    }
    setThreadFocus(focusMessageId ? { messageId: focusMessageId, nonce: Date.now() } : null);
    setThreadRootId(rootId);
  }, [threadRootId]);
  /** From a thread reply back to where it was shared in the main chat. */
  const revealMainMessage = useCallback((messageId: string) => {
    const target = findThreadMessageElement(contentRef.current, messageId);
    if (!target) return false;
    stickToBottomRef.current = false;
    flashThreadTarget(target);
    return true;
  }, []);
  useEffect(() => {
    if (!group?.serverBacked || !threadRootId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
      if (event.target !== document.body && !threadLayoutRef.current?.contains(event.target as Node) && !threadHeaderRef.current?.contains(event.target as Node)) return;
      if (document.querySelector('[data-text-lightbox-overlay], [data-mermaid-lightbox-overlay]')) return;
      if (shareSelectionStore.isActive(shareScope) || shareSelectionStore.isActive(`${shareScope}:thread:${threadRootId}`)) return;
      event.stopPropagation();
      closeThread();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [group?.serverBacked, threadRootId, closeThread, shareScope]);
  const settingsLabel = t('bots.groupChat.settings.open');
  const headerMembers = headerGroup ? memberKey(headerGroup.members) : '';
  const header = useMemo(() => {
    if (!headerGroup) return null;
    const names = botGroupMemberNames(headerGroup.members, separator);
    return (
      <div ref={threadHeaderRef} data-testid="bot-group-content-header" className="flex h-full w-full min-w-0 items-center gap-2 pr-2">
        <button
          type="button"
          onClick={openSettings}
          className="flex min-w-0 items-center gap-2 rounded-full px-2 py-1 text-left hover:bg-[var(--surface-hover)]"
          style={WINDOW_NO_DRAG_STYLE}
        >
          <BotGroupAvatarStack members={headerGroup.members} />
          <span className="min-w-0 truncate text-13 font-medium text-[var(--text-primary)]">{headerGroup.name}</span>
          <span className="hidden min-w-0 truncate text-12 text-[var(--text-tertiary)] sm:inline" title={names}>
            {names}
          </span>
        </button>
        <div className="ml-auto flex shrink-0 items-center">
          {headerGroup.serverBacked && headerGroup.canInvite && <ChatInviteButton groupId={headerGroup.id} />}
          <Tip text={settingsLabel}>
            <button
              type="button"
              onClick={openSettings}
              aria-label={settingsLabel}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-tertiary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
              style={WINDOW_NO_DRAG_STYLE}
            >
              <Settings2 size={15} />
            </button>
          </Tip>
        </div>
      </div>
    );
    // headerMembers stands in for the member array, which is new on every read.
  }, [headerGroup?.name, headerGroup?.id, headerGroup?.serverBacked, headerGroup?.canInvite, headerMembers, openSettings, separator, settingsLabel]);
  useRegisterContentHeader(header);

  // Follow new messages and banner viewport changes only while the reader is at the bottom.
  const lastSequence = messages[messages.length - 1]?.sequence ?? 0;
  // Several Bots think at once in a broadcast round's first circle; the key follows the set.
  const speakingKey =
    group?.round.status === 'running' ? group.round.speakers.map((speaker) => speaker.botId).join(',') : '';
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const anchor = prependAnchorRef.current;
    if (anchor) {
      prependAnchorRef.current = null;
      element.scrollTop = anchor.top + (element.scrollHeight - anchor.height);
      return;
    }
    if (stickToBottomRef.current) element.scrollTop = element.scrollHeight;
  }, [lastSequence, speakingKey, messages.length, pendingSends.length, hasControlledBanner, controlledBannerCollapsed]);

  // Markdown, code blocks and avatars finish layout after the first paint; keep a reader
  // who is at the bottom pinned there while the content grows.
  const ready = state.kind === 'ready';
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!ready || !scroller || !content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickToBottomRef.current && !prependAnchorRef.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [ready]);

  /** Reads one older page; returns it so 引用 can keep paging toward the original. */
  const loadOlder = async (beforeSequence?: number): Promise<{ messages: BotGroupMessageView[]; hasMore: boolean } | null> => {
    const base = stateRef.current;
    if (base.kind !== 'ready' || loadingOlderRef.current) return null;
    const loaded = mergeBotGroupMessages(base.older, base.group.messages);
    const before = beforeSequence ?? loaded[0]?.sequence;
    const api = botGroupApi();
    if (!before || !api) return null;
    const owner = getDataOwnerGeneration();
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const sourceMessageIds = loaded.map(message => message.id);
      const result = await api.getBotGroup(groupId, { beforeSequence: before, sourceMessageIds });
      if (!isDataOwnerGenerationCurrent(owner)) return null;
      if (!result.ok) {
        toast.error(t('bots.groupChat.timeline.loadEarlierFailed'));
        return null;
      }
      const element = scrollRef.current;
      if (element) prependAnchorRef.current = { height: element.scrollHeight, top: element.scrollTop };
      const newerRefresh = stateRef.current.kind === 'ready' && stateRef.current.group !== base.group;
      setState((previous) => {
        if (previous.kind !== 'ready') return previous;
        // A newer push refresh wins over an older in-flight pagination request.
        const executionFailures = previous.group === base.group
          ? result.group.executionFailures ?? previous.group.executionFailures
          : previous.group.executionFailures;
        return {
          ...previous,
          group: { ...previous.group, executionFailures },
          older: mergeBotGroupMessages(previous.older, result.group.messages),
          olderPlans: mergeBotGroupPlans(result.group.plans, previous.olderPlans),
          olderHasMore: result.group.hasMoreBefore,
        };
      });
      // A push may have refreshed before these sources were displayed. Reconcile their current state too.
      if (newerRefresh) loadRef.current(result.group.messages.map(message => message.id));
      return { messages: result.group.messages, hasMore: result.group.hasMoreBefore };
    } catch {
      toast.error(t('bots.groupChat.timeline.loadEarlierFailed'));
      return null;
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  };

  /**
   * Goes to a quoted message in this group's main timeline, paging back a bounded number
   * of times. A deleted or unreachable original says so instead of jumping anywhere else.
   */
  const locateQuoted = async (quote: BotGroupQuoteView) => {
    if (locatingRef.current) return;
    const find = (list: readonly BotGroupMessageView[]) => list.find(message => message.id === quote.messageId && !message.threadRootId);
    const settle = (original: BotGroupMessageView | undefined) => {
      if (original && !original.deleted) setJumpTarget(original.id);
      else toast.info(t(original ? 'bots.groupChat.quote.deleted' : 'bots.groupChat.quote.unavailable'));
    };
    const base = stateRef.current;
    if (base.kind !== 'ready') return;
    const latest = find(base.group.messages);
    if (latest) { settle(latest); return; }
    locatingRef.current = true;
    // Push refreshes re-read only the newest page, so an original on an older page may have
    // changed since it was paged in: re-read its page first and go by what that says.
    const paged = find(base.older);
    if (paged) {
      try {
        // A failed re-read is not a verified original: stay put rather than jump to a stale copy.
        const read = await loadOlder(paged.sequence + 1);
        if (!read) return;
        const original = find(read.messages);
        if (original) setUnverifiedOriginals((previous) => {
          if (!previous.has(original.id)) return previous;
          const next = new Set(previous);
          next.delete(original.id);
          return next;
        });
        settle(original);
      } finally {
        locatingRef.current = false;
      }
      return;
    }
    try {
      let hasMore = base.older.length > 0 ? base.olderHasMore : base.group.hasMoreBefore;
      let before: number | undefined;
      for (let page = 0; hasMore && page < QUOTE_LOCATE_MAX_PAGES; page += 1) {
        const read = await loadOlder(before);
        if (!read) return;
        const original = find(read.messages);
        if (original) { settle(original); return; }
        const oldest = read.messages.reduce((min, message) => Math.min(min, message.sequence), Number.POSITIVE_INFINITY);
        hasMore = read.hasMore && Number.isFinite(oldest) && (quote.sequence === null || oldest > quote.sequence);
        before = Number.isFinite(oldest) ? oldest : undefined;
      }
      settle(undefined);
    } finally {
      locatingRef.current = false;
    }
  };

  // The original is on screen after the render that loaded it: center it, move focus, light it up.
  useEffect(() => {
    if (!jumpTarget) return;
    const target = [...(contentRef.current?.querySelectorAll<HTMLElement>('[data-bot-group-message-id]') ?? [])]
      .find(element => element.dataset.botGroupMessageId === jumpTarget);
    if (!target) return;
    setJumpTarget(null);
    stickToBottomRef.current = false;
    target.scrollIntoView?.({ block: 'center' });
    target.focus({ preventScroll: true });
    setHighlightId(jumpTarget);
  }, [jumpTarget, messages]);
  useEffect(() => {
    if (!highlightId) return;
    const timer = window.setTimeout(() => setHighlightId(null), QUOTE_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlightId]);

  const continueRound = async () => {
    const api = botGroupApi();
    if (!api || continuing) return;
    setContinuing(true);
    stickToBottomRef.current = true;
    try {
      const result = await api.continueBotGroupRound(groupId);
      if (!result.ok) toast.error(t('bots.groupChat.timeline.continueFailed'));
      else loadRef.current();
    } catch {
      toast.error(t('bots.groupChat.timeline.continueFailed'));
    } finally {
      setContinuing(false);
    }
  };

  /** 开始 / 不用了 / 继续 / 重试 / 结束分工; main pushes 'plan' and the view re-reads. */
  const runPlanAction = async (action: BotGroupPlanAction, planId: string) => {
    if (planPendingRef.current) return;
    planPendingRef.current = true;
    setPlanPending({ planId, action });
    stickToBottomRef.current = true;
    try {
      const result = await runBotGroupPlanAction(action, { groupId, planId });
      if (!result) return;
      if (!result.ok) toast.error(t(botGroupErrorKey(result.errorCode, PLAN_ACTION_FAILED[action])));
      loadRef.current();
    } catch {
      toast.error(t(PLAN_ACTION_FAILED[action]));
    } finally {
      planPendingRef.current = false;
      setPlanPending(null);
    }
  };

  const editPlanStep = async (
    planId: string,
    step: BotGroupPlanStepView,
    action: 'reassign' | 'remove',
    botId?: string,
  ) => {
    if (planPendingRef.current) return;
    planPendingRef.current = true;
    setPlanPending({ planId, action: 'edit' });
    try {
      const result = await editBotGroupPlanStep({
        groupId,
        planId,
        position: step.position,
        action,
        ...(botId ? { botId } : {}),
      });
      if (!result) return;
      if (!result.ok) toast.error(t(botGroupErrorKey(result.errorCode, 'bots.groupChat.plan.editFailed')));
      loadRef.current();
    } catch {
      toast.error(t('bots.groupChat.plan.editFailed'));
    } finally {
      planPendingRef.current = false;
      setPlanPending(null);
    }
  };

  const resetDrag = () => {
    dragCounterRef.current = 0;
    setDragOver(false);
  };

  /** Same drop routing as a task's chat area, minus folder references a group does not have. */
  const dropAttachments = (event: DragEvent) => {
    // .cindy / .cshare drops belong to the window-level import; only clear the hint.
    if (isGlobalDropIntercepted(event.nativeEvent)) return;
    const ghostMediaUri = getGhostMediaHandoverFromDataTransfer(event.dataTransfer);
    if (ghostMediaUri) {
      void attachGhostMediaToSession(ghostMediaUri, attachmentScope, t);
      return;
    }
    const attach = (items: Pick<DroppedFileItems, 'files' | 'directories'>) => {
      if (items.directories.length > 0) toast.warning(t('bots.groupChat.composer.folderNotSupported'));
      if (items.files.length > 0) void attachmentState.addFiles(items.files);
    };
    const dropped = getDroppedFileItems(event.dataTransfer);
    attach(dropped);
    if (dropped.unclassified.length > 0) {
      void classifyUnclassifiedDroppedItems(dropped.unclassified, {
        getFilePath: (file) => window.electronAPI.getFilePath(file),
        classifyPath: (path) => window.electronAPI.localDb.sessionShare.classifyPath({ path }),
      }).then(attach);
    }
  };

  if (state.kind === 'loading') {
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)]">
        <BotGroupTimelineLoading />
      </main>
    );
  }
  if (state.kind !== 'ready' || !group) {
    const failed = state.kind === 'error';
    return (
      <main className="flex h-full items-center justify-center bg-[var(--surface)] p-6">
        <section className="w-full max-w-md rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-center">
          <CircleAlert size={24} className="mx-auto text-[var(--text-danger)]" aria-hidden />
          <h1 className="mt-3 text-16 font-medium text-[var(--text-primary)]">
            {t(failed ? 'bots.groupChat.loadFailedTitle' : 'bots.groupChat.unavailableTitle')}
          </h1>
          <p className="mt-2 text-12 leading-5 text-[var(--text-secondary)]">
            {t(failed ? 'bots.groupChat.loadFailedDescription' : 'bots.groupChat.unavailableDescription')}
          </p>
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <Button variant="secondary" size="lg" compact type="button" onClick={() => navigate('/bots')}>
              <ArrowLeft size={14} />
              {t('bots.backToBot')}
            </Button>
            {!failed && groupId && <RemoveChatFromListButton key={groupId} groupId={groupId} onRemoved={() => navigate('/bots')} />}
            {failed ? (
              <Button
                variant="cta"
                size="lg"
                compact
                type="button"
                onClick={() => {
                  setState({ kind: 'loading' });
                  setReloadVersion((value) => value + 1);
                }}
              >
                <RefreshCcw size={14} />
                {t('bots.retry')}
              </Button>
            ) : null}
          </div>
        </section>
      </main>
    );
  }

  const memberById = new Map(group.members.map((member) => [member.botId, member]));
  const planById = new Map(plans.map((plan) => [plan.id, plan]));
  const openPlan = openBotGroupPlan({ openPlan: group.openPlan, plans });
  const followUp = botGroupPlanFollowUp(openPlan);
  const continueId = continuableRoundEndId(messages, group.round);
  const mentionLabels = [t('bots.groupChat.mention.all'), ...group.members.flatMap((member) => [member.name, member.nickname || member.displayName || member.name])];
  // Messages still in the outbox stay where they were sent, between the timeline's own.
  const rows = interleaveBotGroupOutbox(messages, pendingSends);
  const timeGroups = collectBotMessageTimeGroups(rows.map((row) => row.entry
    ? { clientId: outboxKey(row.entry), createdAt: row.entry.createdAt }
    : { clientId: row.message.id, createdAt: row.message.createdAt }));
  const renderOutboxEntry = (entry: BotGroupOutboxEntry) => {
    const groupTime = timeGroups.get(outboxKey(entry));
    return (
      <div key={outboxKey(entry)} className="flex flex-col gap-4">
        {groupTime !== undefined ? (
          <p className="select-none text-center text-12 text-[var(--text-tertiary)]">
            {formatBotMessageGroupTime(groupTime, i18n.language)}
          </p>
        ) : null}
        <BotGroupOutboxItem entry={entry} mentionLabels={mentionLabels} readOnly={Boolean(group.archived || group.dissolvedAt)}
          quote={entry.quote ? (
            <BotGroupQuoteBlock display={resolveBotGroupQuote(entry.quote, quoteSources)}
              onLocate={() => void locateQuoted(entry.quote!)} align="right" />
          ) : null} />
      </div>
    );
  };
  const running = group.round.status === 'running';
  const speakers = running
    ? group.round.speakers.flatMap((speaker) => {
        const member = memberById.get(speaker.botId);
        return member ? [{ member, sessionId: speaker.sessionId, activity: speaker.activity }] : [];
      })
    : [];
  const pendingFor = (planId: string | null) =>
    planId && planPending?.planId === planId ? planPending.action : null;

  return (
    <div ref={threadLayoutRef} className="flex h-full min-w-0 overflow-hidden">
    <main
      className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-[var(--surface)]"
      onDragEnter={(event) => {
        if (!isAttachmentDrag(event)) return;
        event.preventDefault();
        dragCounterRef.current += 1;
        if (dragCounterRef.current === 1) setDragOver(true);
      }}
      onDragOver={(event) => {
        if (!isAttachmentDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={(event) => {
        if (!isAttachmentDrag(event)) return;
        event.preventDefault();
        dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
        if (dragCounterRef.current === 0) setDragOver(false);
      }}
      onDrop={(event) => {
        if (!isAttachmentDrag(event)) return;
        event.preventDefault();
        resetDrag();
        dropAttachments(event);
      }}
    >
      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
          acknowledge();
        }}
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-4 pt-6"
      >
        <div ref={contentRef} className="mx-auto flex w-full max-w-[760px] flex-col gap-4">
          {hasMoreBefore ? (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                compact
                type="button"
                loading={loadingOlder}
                onClick={() => void loadOlder()}
              >
                {t('bots.groupChat.timeline.loadEarlier')}
              </Button>
            </div>
          ) : null}
          {messages.length === 0 && pendingSends.length === 0 && !running ? (
            <div className="py-12 text-center">
              <p className="text-13 font-medium text-[var(--text-secondary)]">
                {t('bots.groupChat.timeline.emptyTitle')}
              </p>
              <p className="mt-1 text-12 text-[var(--text-tertiary)]">
                {t('bots.groupChat.timeline.emptyDescription')}
              </p>
            </div>
          ) : null}
          {rows.map((row) => {
            if (row.entry) return renderOutboxEntry(row.entry);
            const timelineMessage = row.message;
            const groupTime = timeGroups.get(timelineMessage.id);
            // My own message just confirmed: keep the local attachment previews until the server copies are usable.
            const local = localAttachments.get(timelineMessage.id);
            const message = local && timelineMessage.isSelf !== false && !timelineMessage.deleted
              ? { ...timelineMessage, attachments: mergeBotGroupLocalAttachments(timelineMessage.attachments, local) }
              : timelineMessage;
            return (
              <div key={message.id} className="flex flex-col gap-4">
                {groupTime !== undefined ? (
                  <p className="select-none text-center text-12 text-[var(--text-tertiary)]">
                    {formatBotMessageGroupTime(groupTime, i18n.language)}
                  </p>
                ) : null}
                <div
                  data-bot-group-message-id={message.id}
                  // Focusable only as a jump target, so a click elsewhere keeps its usual focus.
                  tabIndex={jumpTarget === message.id || highlightId === message.id ? -1 : undefined}
                  className={cn(
                    '-m-1.5 rounded-xl p-1.5 outline-none transition-colors',
                    highlightId === message.id && 'bg-[hsl(var(--search-match-bg))] ring-1 ring-[var(--border-default)]',
                  )}
                >
                <BotGroupTimelineItem
                  message={message}
                  shareScope={shareScope}
                  sharing={sharing}
                  quoteDisplay={message.quote ? resolveBotGroupQuote(message.quote, quoteSources) : undefined}
                  onLocateQuote={message.quote ? () => void locateQuoted(message.quote!) : undefined}
                  actions={message.kind === 'message' ? <ChatMessageActions
                    groupId={group.serverBacked ? group.id : undefined} shareScope={shareScope} message={message} members={group.members} reactionRevision={messageReactionRevision(group, message.id)}
                    align={message.authorKind === 'user' && message.isSelf !== false ? 'right' : 'left'}
                    onQuote={group.serverBacked && !group.archived && !group.dissolvedAt && isBotGroupMessageQuotable(message)
                      ? () => setQuoteDraft(botGroupQuoteFromMessage(message)) : undefined}
                    onReply={group.serverBacked ? () => openThread(message.id) : undefined}
                    replyCountShown={group.serverBacked && (message.replyCount ?? 0) > 0}
                    // A share copies the server's reply, never the card's fallback text.
                    copyText={message.threadShare ? message.threadShare.status === 'available' ? message.threadShare.content : '' : undefined}
                    onChanged={() => loadRef.current()} /> : undefined}
                  onOpenThread={group.serverBacked ? (rootId, focusMessageId) => openThread(rootId, focusMessageId) : undefined}
                  member={message.authorBotId ? memberById.get(message.authorBotId) : undefined}
                  members={group.members}
                  mentionLabels={mentionLabels}
                  canContinue={message.id === continueId}
                  continuing={continuing}
                  onContinue={() => void continueRound()}
                  plan={message.planId ? planById.get(message.planId) : undefined}
                  planActionable={
                    message.kind === 'plan' &&
                    openPlan !== null &&
                    openPlan.id === message.planId &&
                    openPlan.status === 'proposed'
                  }
                  planReassignable={
                    message.kind === 'plan' &&
                    openPlan !== null &&
                    openPlan.id === message.planId &&
                    openPlan.status === 'waiting'
                  }
                  planPending={planCardPending(pendingFor(message.planId))}
                  onPlanAction={(action) => {
                    if (message.planId) void runPlanAction(action, message.planId);
                  }}
                  onEditStep={(step, action, botId) => {
                    if (message.planId) void editPlanStep(message.planId, step, action, botId);
                  }}
                />
                </div>
              </div>
            );
          })}
          {openPlan && followUp ? (
            <BotGroupPlanFollowUpRow
              followUp={followUp}
              members={group.members}
              pending={followUpPending(pendingFor(openPlan.id))}
              onContinue={() => void runPlanAction('continue', openPlan.id)}
              onRetry={() => void runPlanAction('retry', openPlan.id)}
              onEnd={() => void runPlanAction('dismiss', openPlan.id)}
            />
          ) : null}
          {speakers.map(({ member, sessionId, activity }) => (
            <BotGroupSpeakingRow
              key={`${member.botId}:${activity}`}
              speaker={member}
              sessionId={sessionId}
              activity={activity}
            />
          ))}
        </div>
      </div>
      {hasControlledBanner && (
        // Like teammate chats, keep the collapsed breathing light above the composer.
        <div className="shrink-0 px-5 pt-2">
          <div className="mx-auto flex w-full max-w-[760px] justify-center px-2">
            <ControlledBanner placement="composer" sessionId={controlledBannerKey} />
          </div>
        </div>
      )}
      {sharing ? <ShareSelectionBar sessionId={shareScope} barWidth="100%"
        getContentWidth={() => contentRef.current?.querySelector('article')?.getBoundingClientRect().width ?? 760} /> : group.archived || group.dissolvedAt ? <p className="border-t border-[var(--border-default)] p-4 text-center text-13 text-[var(--text-tertiary)]">{t(group.dissolvedAt ? 'bots.groupChat.lifecycle.dissolved' : 'bots.groupChat.server.settings.archived')}</p> : <BotGroupComposer
        groupId={group.id}
        members={group.members}
        running={running}
        planState={botGroupComposerPlanState(openPlan)}
        attachments={attachmentState}
        attachmentScope={attachmentScope}
        dragOver={dragOver}
        quote={quoteDraft ? { view: quoteDraft, display: resolveBotGroupQuote(quoteDraft, quoteSources) } : null}
        onQuoteChange={setQuoteDraft}
        onSending={() => {
          stickToBottomRef.current = true;
        }}
      />}
      {group.migrationPending && <p role="status" className="px-4 py-2 text-13 text-[var(--text-secondary)]">{t('bots.groupChat.migrationPending')}</p>}
      {/* Whole-page drop hint, as over a task's chat area; the card repeats it. */}
      {dragOver ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-50"
          style={{
            backgroundColor: 'var(--drop-overlay-bg)',
            border: '2px dashed var(--drop-overlay-border)',
          }}
        />
      ) : null}
    </main>
    {group.serverBacked && threadRootId && <ChatThreadPanel key={`${group.id}:${threadRootId}`} group={group} rootId={threadRootId} quoteSources={quoteSources}
      focus={threadFocus} sharedReplies={sharedReplies} onRevealShare={revealMainMessage} onClose={closeThread} />}
    </div>
  );
}

/** Older shares checked before the latest edit, deletion or reset: they may be out of date. */
function staleBotGroupShares(older: readonly BotGroupMessageView[], version: number | undefined) {
  return older.filter(message => message.threadShare && version !== undefined && (message.threadShare.version ?? 0) < version);
}

/** One refresh covers all loaded references, including pending sources and attachments. */
function botGroupShownShares(older: readonly BotGroupMessageView[]) {
  return older.filter(message => message.threadShare).map(message => ({
    id: message.id, messageId: message.threadShare!.messageId, threadRootId: message.threadShare!.threadRootId,
    ...(message.authorBotId ? { sharerId: message.authorBotId } : {}) }));
}

/**
 * Apply the refreshed older shares. One this refresh could not check that is older than the
 * latest version stops quoting its old text until a later refresh confirms it.
 */
function applyBotGroupThreadShareUpdates(older: BotGroupMessageView[], group: Pick<BotGroupDetail, 'threadShareUpdates' | 'threadShareVersion'>) {
  const { threadShareUpdates: updates, threadShareVersion: version } = group;
  if (!updates && version === undefined) return older;
  let changed = false;
  const next = older.map(message => {
    const share = message.threadShare;
    if (!share) return message;
    const update = updates?.[message.id];
    if (update) { changed = true; return { ...message, threadShare: update }; }
    if (version === undefined || (share.version ?? 0) >= version || share.status !== 'available') return message;
    changed = true;
    return { ...message, threadShare: { ...share, status: 'loading' as const, authorName: '', authorBotId: null, content: '', attachments: [], edited: false } };
  });
  return changed ? next : older;
}

function BotGroupTimelineLoading() {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), TIMELINE_LOADING_REVEAL_MS);
    return () => clearTimeout(timer);
  }, []);
  if (!visible) return null;
  return (
    <Spinner
      size={20}
      data-testid="bot-group-timeline-loading"
      className="text-[var(--text-tertiary)]"
      role="status"
      aria-label={t('ccAgent.common.loading')}
    />
  );
}

function planCardPending(action: PlanPending['action'] | null): BotGroupPlanCardAction | null {
  return action === 'start' || action === 'dismiss' || action === 'edit' ? action : null;
}

function followUpPending(action: PlanPending['action'] | null): BotGroupFollowUpAction | null {
  return action === 'continue' || action === 'retry' || action === 'dismiss' ? action : null;
}

function BotGroupTimelineItem({
  message,
  shareScope,
  sharing,
  quoteDisplay,
  onLocateQuote,
  actions,
  member,
  members,
  mentionLabels,
  canContinue,
  continuing,
  onContinue,
  plan,
  planActionable,
  planReassignable,
  planPending,
  onPlanAction,
  onEditStep,
  onOpenThread,
}: {
  message: BotGroupMessageView;
  shareScope: string;
  sharing: boolean;
  /** 引用回复: how the quoted message reads now; absent when this message quotes nothing. */
  quoteDisplay?: BotGroupQuoteDisplay;
  onLocateQuote?: () => void;
  actions?: ReactNode;
  /** Server groups: open a thread, optionally bringing one of its replies into view. */
  onOpenThread?: (rootId: string, focusMessageId?: string) => void;
  member: BotGroupMemberView | undefined;
  members: readonly BotGroupMemberView[];
  mentionLabels: readonly string[];
  canContinue: boolean;
  continuing: boolean;
  onContinue: () => void;
  /** Snapshot of the plan this message belongs to (安排卡, hand-off or plan end). */
  plan: BotGroupPlanView | undefined;
  planActionable: boolean;
  /** The open plan stopped after a step: a step not yet done can change hands before 继续 / 重试. */
  planReassignable: boolean;
  planPending: BotGroupPlanCardAction | null;
  onPlanAction: (action: 'start' | 'dismiss') => void;
  onEditStep: (step: BotGroupPlanStepView, action: 'reassign' | 'remove', botId?: string) => void;
}) {
  const { t } = useTranslation();
  if (message.kind === 'round-end') {
    return (
      <div className="flex select-none items-center gap-3 text-12 text-[var(--text-tertiary)]">
        <span aria-hidden className="h-px flex-1 bg-[var(--border-default)]" />
        <span>{t('bots.groupChat.timeline.roundEnded')}</span>
        {canContinue ? (
          <Button variant="secondary" size="sm" compact type="button" loading={continuing} onClick={onContinue}>
            {t('bots.groupChat.timeline.continue')}
          </Button>
        ) : null}
        <span aria-hidden className="h-px flex-1 bg-[var(--border-default)]" />
      </div>
    );
  }
  if (message.kind === 'plan-end') {
    return <BotGroupPlanEndDivider stepCount={plan ? plan.steps.length : null} />;
  }
  if (message.kind === 'notice' || message.authorKind === 'system') {
    const name = message.authorName.trim() || member?.name || '';
    if (isBotGroupRuntimeFailureCode(message.runtimeFailureCode)) {
      return <BotGroupRuntimeFailureNotice name={name} code={message.runtimeFailureCode} />;
    }
    const key = botGroupNoticeKey(message.noticeCode, message.planId !== null);
    const text = key ? t(key, { name }) : message.content;
    return <p className="text-center text-12 text-[var(--text-tertiary)]">{text}</p>;
  }
  const selfMessage = message.kind === 'message' && message.authorKind === 'user' && message.isSelf !== false;
  const threadPreview = onOpenThread && message.kind === 'message' && (message.replyCount ?? 0) > 0 ? (
    <BotGroupThreadPreview message={message} members={members} align={selfMessage ? 'right' : 'left'}
      onOpen={() => onOpenThread(message.id)} />
  ) : null;
  const share = message.kind === 'message' ? message.threadShare : undefined;
  const shareBody = share && onOpenThread ? (
    <>
      <p className="flex min-w-0 select-none items-center gap-1 text-12 text-[var(--text-tertiary)]">
        <CornerDownRight size={12} aria-hidden className="shrink-0" />
        <span className="min-w-0 truncate">{botGroupThreadShareLabel(share, t)}</span>
      </p>
      <BotGroupThreadShareQuote share={share} members={members}
        attachments={<BotGroupMessageAttachments attachments={share.attachments} align="start" />}
        onOpenThread={() => onOpenThread(share.threadRootId, share.messageId)} />
    </>
  ) : null;
  if (selfMessage && shareBody) {
    return (
      <article {...{ [SHARE_SESSION_ATTR]: shareScope, [SHARE_MESSAGE_ATTR]: message.id }}
        className={`relative flex justify-end ${sharing ? 'ml-10' : ''}`}>
        {sharing && <ShareMessageCheckbox clientId={message.id} />}
        <div className="flex min-w-0 w-[72%] max-w-[560px] flex-col items-end gap-1.5">
          {shareBody}
          {threadPreview}
          {actions}
        </div>
      </article>
    );
  }
  if (selfMessage) {
    return (
      <article {...{ [SHARE_SESSION_ATTR]: shareScope, [SHARE_MESSAGE_ATTR]: message.id }}
        className={`relative flex justify-end ${sharing ? 'ml-10' : ''}`}>
        {sharing && <ShareMessageCheckbox clientId={message.id} />}
        <BotGroupSelfBubble content={message.content} attachments={message.attachments} mentionLabels={mentionLabels}
          quote={quoteDisplay ? <BotGroupQuoteBlock display={quoteDisplay} onLocate={onLocateQuote} align="right" /> : null}>
          {threadPreview}
          {actions}
        </BotGroupSelfBubble>
      </article>
    );
  }
  // A server plan is signed by its human creator; present the organizer without changing authorship.
  const isPlanCard = message.kind === 'plan';
  const identity = isPlanCard ? members.find(candidate => candidate.botId === plan?.organizerBotId) : member;
  const author = {
    name: isPlanCard ? identity?.name || plan?.organizerName || '' : message.authorName || identity?.name || '',
    avatar: identity?.avatar ?? null,
    avatarUrl: identity?.avatarUrl,
    avatarColor: identity?.avatarColor ?? null,
  };
  const hasText = message.content.trim().length > 0;
  return (
    <article {...(message.kind === 'message' ? { [SHARE_SESSION_ATTR]: shareScope, [SHARE_MESSAGE_ATTR]: message.id } : {})}
      className={`relative flex min-w-0 items-start gap-2.5 ${sharing ? 'ml-10' : ''}`}>
      {sharing && message.kind === 'message' && <ShareMessageCheckbox clientId={message.id} />}
      <BotAvatar bot={author} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 select-none items-center gap-2">
          <span className="min-w-0 truncate text-13 font-medium leading-7 text-[var(--text-primary)]">
            {author.name}
          </span>
          {isPlanCard ? <BotGroupOrganizerTag /> : null}
        </span>
        {isPlanCard ? (
          <BotGroupPlanCard
            plan={plan}
            members={members}
            actionable={planActionable}
            reassignable={planReassignable}
            pending={planPending}
            onStart={() => onPlanAction('start')}
            onDismiss={() => onPlanAction('dismiss')}
            onEditStep={onEditStep}
          />
        ) : (
          <>
            {quoteDisplay ? <BotGroupQuoteBlock display={quoteDisplay} onLocate={onLocateQuote} /> : null}
            {shareBody ? <div className="flex min-w-0 flex-col gap-1.5">{shareBody}</div> : hasText ? (
              <div className={`min-w-0 text-[var(--msg-assistant-text)] ${CHAT_BODY_CLASS}`}>
                <MarkdownRenderer workingDir="" content={message.content} allowPrivilegedLinks={false} />
              </div>
            ) : null}
            {shareBody ? null : <BotGroupMessageAttachments attachments={message.attachments} align="start" />}
            <BotGroupHandoffFiles files={message.files} workDir={plan?.workDir ?? null} />
            {threadPreview ? <div className="mt-1 flex min-w-0">{threadPreview}</div> : null}
            {actions}
          </>
        )}
      </div>
    </article>
  );
}

/** The current user's own message: attachments, then the text bubble, then what goes under it. */
function BotGroupSelfBubble({
  content,
  attachments,
  mentionLabels,
  quote,
  children,
}: {
  content: string;
  attachments: readonly BotGroupAttachment[];
  mentionLabels: readonly string[];
  /** The 引用回复 block above the message. */
  quote?: ReactNode;
  children?: ReactNode;
}) {
  // An attachment-only message shows just its attachments, without an empty bubble.
  const hasText = content.trim().length > 0;
  return (
    <div className="flex min-w-0 max-w-[72%] flex-col items-end gap-2">
      {quote}
      <BotGroupMessageAttachments attachments={attachments} align="end" />
      {hasText ? (
        <div
          className={`max-w-full whitespace-pre-wrap break-words rounded-xl border border-[var(--msg-user-border)] bg-[var(--msg-user-bg)] px-3.5 py-2.5 text-[var(--msg-user-text)] ${CHAT_BODY_CLASS}`}
        >
          {splitBotGroupMentionSegments(content, mentionLabels).map((segment, index) =>
            segment.mention ? (
              <span
                key={index}
                className="rounded-full bg-[var(--surface-chip)] px-1.5 font-medium"
              >
                {segment.text}
              </span>
            ) : (
              <span key={index}>{segment.text}</span>
            ),
          )}
        </div>
      ) : null}
      {children}
    </div>
  );
}

function outboxKey(entry: BotGroupOutboxEntry): string {
  return `outbox:${entry.input.clientId}`;
}

/** Wait this long before saying 发送中, so a quick send never flashes a status. */
const BOT_GROUP_SENDING_HINT_DELAY_MS = 600;

/**
 * A message the user just sent, shown before main has it in the timeline. Not yet a
 * timeline message: no share checkbox, reply or reactions until the real one replaces it.
 */
function BotGroupOutboxItem({
  entry,
  mentionLabels,
  readOnly,
  quote,
}: {
  entry: BotGroupOutboxEntry;
  mentionLabels: readonly string[];
  readOnly: boolean;
  quote?: ReactNode;
}) {
  const { t } = useTranslation();
  const sending = entry.status === 'sending';
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!sending) {
      setSlow(false);
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), BOT_GROUP_SENDING_HINT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [sending]);
  return (
    <article data-testid="bot-group-outbox" data-status={entry.status} className="relative flex justify-end">
      <BotGroupSelfBubble content={entry.input.text} attachments={entry.attachments} mentionLabels={mentionLabels} quote={quote}>
        {sending && slow ? (
          <p role="status" className="select-none text-12 leading-[1.33] text-[var(--text-tertiary)]">
            {t('bots.groupChat.outbox.sending')}
          </p>
        ) : null}
        {entry.status === 'failed' ? (
          <div role="alert" className="flex flex-wrap items-center justify-end gap-2">
            <span className="flex select-none items-center gap-1 text-12 leading-[1.33] text-[var(--text-danger)]">
              <CircleAlert size={13} aria-hidden className="shrink-0" />
              {t('bots.groupChat.outbox.failed')}
            </span>
            <Button
              variant="secondary"
              size="sm"
              compact
              type="button"
              disabled={readOnly}
              onClick={() => {
                if (!editBotGroupSend(entry.input.groupId, entry.input.clientId)) toast.warning(t('bots.groupChat.outbox.editBlocked'));
              }}
            >
              {t('bots.groupChat.outbox.edit')}
            </Button>
            {entry.retryable !== false ? (
              <Button variant="secondary" size="sm" compact type="button" disabled={readOnly} onClick={() => retryBotGroupSend(entry.input.groupId, entry.input.clientId)}>
                <RefreshCcw size={13} />
                {t('bots.retry')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </BotGroupSelfBubble>
    </article>
  );
}


function BotGroupSpeakingRow({
  speaker,
  sessionId,
  activity: speakerActivity,
}: {
  speaker: BotGroupMemberView;
  sessionId: string | null;
  activity: BotGroupSpeakerActivity;
}) {
  const { t } = useTranslation();
  const activity = useAgentIslandActivity(sessionId ?? '');
  const waiting = activity?.phase === 'needs-interaction';
  return (
    <article
      data-testid="bot-group-speaking"
      data-activity={speakerActivity}
      className="flex min-w-0 items-start gap-2.5"
    >
      <BotAvatar bot={speaker} size="sm" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className="select-none text-13 font-medium leading-7 text-[var(--text-primary)]">
          {speaker.name}
        </span>
        {!waiting ? (
          <p
            role="status"
            aria-live="polite"
            className="-mt-2 flex min-w-0 items-center gap-1.5 text-13 text-[var(--status-bar-accent)]"
          >
            <Sparkles size={14} className="shrink-0 -translate-y-px" aria-hidden />
            <span className="min-w-0 truncate">
              {speakerActivity === 'planning' ? (
                // The organizer's decision runs outside any Session, so there is no live phase to show.
                t('bots.groupChat.speaking.planning')
              ) : (
                <BotGenerationLabel
                  sessionId={sessionId ?? undefined}
                  phase={activity?.workingPhase ?? 'thinking'}
                  startedAt={activity?.startedAtMs ?? null}
                />
              )}
            </span>
          </p>
        ) : null}
        {sessionId ? (
          <BotGroupPendingInteraction
            sessionId={sessionId}
            bot={{ id: speaker.botId, name: speaker.name, avatar: speaker.avatar, avatarColor: speaker.avatarColor }}
          />
        ) : null}
      </div>
    </article>
  );
}
