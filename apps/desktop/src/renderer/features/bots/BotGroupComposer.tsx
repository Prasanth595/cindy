/**
 * 群聊输入框：纯文本，Enter 发送、Shift+Enter 换行，IME 组合中不发送
 * （DESIGN.md §14.3）。输入 `@` 弹出点名候选（useBotGroupMentionPicker，与 Thread 回复框同一套）。
 *
 * 发送时以正文重新解析点名（见 botGroupMentions.ts），clientId 作为幂等键：同一段
 * 文字发送失败后重发沿用同一个 clientId，main 会返回第一次写入的那条消息。一轮进行
 * 中输入框为空时，发送按钮变成停止；有文字时照常发送——插话本身就会作废当前一轮
 * （docs/product-rules/bot-group-chat.md §4.4）。
 *
 * 发送即交给群聊发件箱（botGroupOutbox.ts）：消息立即出现在时间线上，输入框与托盘马上
 * 空出来，可以接着写下一条；提交按发出顺序在后台进行。没发出去时，输入框空着就把正文、
 * 点名、「分工」标签和附件原样放回，再按发送沿用同一个 clientId；输入框已有新内容时
 * 消息留在时间线上，可以重试或编辑。
 *
 * 「+」菜单里的「安排分工」（§7.2）给输入框加上「分工」标签：带标签发出的消息一定交给
 * 负责人出安排（`division: true`），发出后标签清掉。安排进行中或等继续时不能再安排新的，
 * 菜单项置灰并说明原因。占位文字跟随未结束的安排，告诉用户这时说的话会交给谁。
 *
 * 「引用回复」（§10）：页面持有当前群的待发引用，输入框上方显示紧凑的引用块，× 或 Esc
 * 只取消引用、不动正文。引用随发送一起交给 main（只带消息 id，摘要由 main 从服务器读），
 * 也是幂等键的一部分；发送失败时与正文一同放回，原消息已不可用时只放回正文。
 *
 * 附件（§3.1）与普通聊天同一套：托盘状态来自页面持有的 `useAttachments`（整页拖入也能
 * 加），缩略图与拒收提示复用 ComposerAttachments；「+」→「添加文件、图片或视频…」、粘贴
 * 文件或截图都进托盘。有附件时可以不写字。发送时这一批随消息离开托盘
 * （不删除文件），发件箱提交前烧录图片标注；没发出去就随消息放回。
 */
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
} from 'react';
import { Paperclip, Plus, Users, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { AttachmentRejectionStrip, ThumbnailStrip } from '@/components/new-chat/ComposerAttachments';
import { SendButton } from '@/components/new-chat/SendButton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tip } from '@/components/ui/tooltip';
import { MENU_ITEM_CLASS } from '@/features/cc-agent/sidebar/menuStyles';
import type { UseAttachmentsReturn } from '@/hooks/useAttachments';
import type { AttachedFile } from '@/lib/fileTypes';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import {
  BOT_GROUP_ATTACHMENTS_MAX,
  BOT_GROUP_MESSAGE_MAX_CHARS,
  type BotGroupMemberView,
  type BotGroupQuoteDisplay,
  type BotGroupQuoteView,
} from '../../../shared/botGroupChat';
import { BotGroupQuotePreview } from './BotGroupQuote';
import {
  BOT_GROUP_COMPOSER_CARD,
  BOT_GROUP_COMPOSER_COLUMN,
  BOT_GROUP_COMPOSER_DOCK,
  BOT_GROUP_COMPOSER_FOOTER,
  BOT_GROUP_COMPOSER_FOOTER_START,
  BOT_GROUP_COMPOSER_INPUT,
  fitBotGroupComposerInput,
  keepBotGroupComposerInputFocus,
  useRefitBotGroupComposerInputOnResize,
} from './botGroupComposerChrome';
import { botGroupAttachmentSignature } from './botGroupAttachments';
import { botGroupSendSignature, enqueueBotGroupSend, registerBotGroupComposer } from './botGroupOutbox';
import {
  isActiveBotGroupMember,
  isBotGroupDivisionBlocked,
  type BotGroupComposerPlanState,
} from './botGroupPresentation';
import { botGroupApi } from './botGroupStore';
import { useBotGroupMentionPicker } from './useBotGroupMentionPicker';

function isComposingKey(event: KeyboardEvent): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}

/** The composer's slice of `useAttachments`, owned by the page so a drop anywhere adds files. */
export type BotGroupComposerAttachments = Pick<
  UseAttachmentsReturn,
  | 'attachments'
  | 'addFiles'
  | 'addClipboardImage'
  | 'rejections'
  | 'dismissRejection'
  | 'removeFile'
  | 'updateFile'
  | 'restoreFiles'
  | 'clearFiles'
>;

/** Real path of a pasted or dropped file; empty for an in-memory bitmap. */
function filePathOf(file: File): string {
  try {
    return window.electronAPI.getFilePath(file);
  } catch {
    return '';
  }
}

export function BotGroupComposer({
  groupId,
  members,
  running,
  planState = null,
  attachments: attachmentState,
  attachmentScope,
  dragOver = false,
  quote = null,
  onQuoteChange,
  onSending,
}: {
  groupId: string;
  members: readonly BotGroupMemberView[];
  running: boolean;
  /** The group's open plan, for placeholders and the 「安排分工」 gate. */
  planState?: BotGroupComposerPlanState | null;
  attachments: BotGroupComposerAttachments;
  /** Scope for writing annotated images before send (see botGroupAttachmentScope). */
  attachmentScope: string;
  /** Files are being dragged over the page: the card shows the same drop hint as a task's. */
  dragOver?: boolean;
  /** 引用回复 waiting to go with the next message, and how its original reads right now. */
  quote?: { view: BotGroupQuoteView; display: BotGroupQuoteDisplay } | null;
  onQuoteChange?: (quote: BotGroupQuoteView | null) => void;
  /** Called when a message enters the outbox, so the view can follow it to the bottom. */
  onSending: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [stopping, setStopping] = useState(false);
  /** 「分工」 tag from 「+」→「安排分工」: this message goes to the organizer for a plan. */
  const [division, setDivision] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mention = useBotGroupMentionPicker({ text, onTextChange: setText, members, textareaRef });
  const textRef = useRef(text);
  textRef.current = text;
  const attachmentsRef = useRef(attachmentState.attachments);
  attachmentsRef.current = attachmentState.attachments;
  const quoteRef = useRef(quote?.view ?? null);
  quoteRef.current = quote?.view ?? null;
  const quotedMessageId = quote?.view.messageId ?? null;
  const focusInputOnMenuCloseRef = useRef(false);
  const stoppingRef = useRef(false);
  const divisionRef = useRef(division);
  divisionRef.current = division;
  /** The failed send last put back into the input: an unchanged resend reuses its clientId. */
  const attemptRef = useRef<{ clientId: string; signature: string } | null>(null);

  const activeMembers = useMemo(() => members.filter(isActiveBotGroupMember), [members]);

  const trimmed = text.trim();
  const tooLong = trimmed.length > BOT_GROUP_MESSAGE_MAX_CHARS;
  const hasMembers = activeMembers.length > 0;
  const attachmentCount = attachmentState.attachments.length;
  const tooManyAttachments = attachmentCount > BOT_GROUP_ATTACHMENTS_MAX;
  const canSend =
    (trimmed.length > 0 || attachmentCount > 0) && !tooLong && !tooManyAttachments && hasMembers;
  const showStop = running && trimmed.length === 0 && attachmentCount === 0;
  const divisionBlocked = isBotGroupDivisionBlocked(planState);

  // Picking 引用回复 brings the caret here, ready to type the reply.
  useEffect(() => {
    if (quotedMessageId) textareaRef.current?.focus();
  }, [quotedMessageId]);

  // Auto-grow; the CSS max height caps it and turns on scrolling.
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    fitBotGroupComposerInput(element);
  }, [text]);
  useRefitBotGroupComposerInputOnResize(textareaRef);

  // A message that did not go out comes back only into an empty input: never over new
  // text, a new tag or files added meanwhile. Pressing send again reuses its clientId.
  // Registered once per group (mount / group change): re-registering on every render would
  // pull a failed message back in the moment the user clears the input.
  const restoreAttachmentsRef = useRef(attachmentState.restoreFiles);
  restoreAttachmentsRef.current = attachmentState.restoreFiles;
  const tRef = useRef(t);
  tRef.current = t;
  const onQuoteChangeRef = useRef(onQuoteChange);
  onQuoteChangeRef.current = onQuoteChange;
  useEffect(
    () =>
      registerBotGroupComposer(groupId, {
        restore: (entry) => {
          if (textRef.current || attachmentsRef.current.length > 0 || divisionRef.current) return false;
          attemptRef.current = { clientId: entry.input.clientId, signature: entry.signature };
          textRef.current = entry.draft;
          setText(entry.draft);
          mention.setTracked([...entry.tracked]);
          const restoredDivision = entry.input.division === true;
          divisionRef.current = restoredDivision;
          if (restoredDivision) setDivision(true);
          // A quote picked meanwhile wins.
          if (entry.quote && !quoteRef.current) {
            quoteRef.current = entry.quote;
            onQuoteChangeRef.current?.(entry.quote);
          }
          if (entry.files.length > 0) attachmentsRef.current = restoreAttachmentsRef.current(entry.files);
          return true;
        },
        notifyFailed: (errorKey) => toast.error(tRef.current(errorKey)),
      }),
    [groupId],
  );

  const send = () => {
    // A second Enter before the cleared input has rendered must not send the same draft twice.
    if (!canSend || textRef.current !== text || attachmentsRef.current !== attachmentState.attachments) return;
    if (!botGroupApi()) {
      toast.error(t('bots.groupChat.composer.sendFailed'));
      return;
    }
    const files: readonly AttachedFile[] = attachmentState.attachments;
    const mentions = mention.resolve(text);
    const tracked = mention.tracked;
    // Every field main gets is part of the attempt's identity (the tag changes what main does
    // with the text, the quote is part of the message), and so are the attachments that go with it.
    const sentQuote = quoteRef.current;
    const fields = {
      groupId,
      text: trimmed,
      mentions,
      ...(division ? { division: true } : {}),
      ...(sentQuote ? { quote: { messageId: sentQuote.messageId } } : {}),
    };
    const signature = botGroupSendSignature({ ...fields, clientId: '' }, botGroupAttachmentSignature(files));
    const clientId = attemptRef.current?.signature === signature ? attemptRef.current.clientId : crypto.randomUUID();
    // The outbox owns this attempt now; a failure hands it back through `restore`.
    attemptRef.current = null;
    enqueueBotGroupSend({
      input: { ...fields, clientId },
      signature,
      draft: text,
      tracked,
      quote: sentQuote,
      files,
      attachmentScope,
    });
    // Clear at once like any chat, so the next message can be written while this one
    // goes out. The batch leaves the tray without deleting its files: the message has them.
    textRef.current = '';
    setText('');
    mention.reset();
    setDivision(false);
    divisionRef.current = false;
    if (sentQuote) {
      quoteRef.current = null;
      onQuoteChange?.(null);
    }
    if (files.length > 0) {
      attachmentState.clearFiles();
      attachmentsRef.current = [];
    }
    onSending();
  };

  /** Files copied in a file manager attach by path; a screenshot or copied image attaches as an image. */
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items || items.length === 0) return;
    const filesWithPath: File[] = [];
    let handled = false;
    for (const item of Array.from(items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;
      // A group has no folder reference; a copied folder pastes as its text.
      if (item.webkitGetAsEntry?.()?.isDirectory) continue;
      if (filePathOf(file)) {
        filesWithPath.push(file);
        handled = true;
      } else if (item.type.startsWith('image/')) {
        void attachmentState.addClipboardImage(file);
        handled = true;
      }
    }
    if (filesWithPath.length > 0) void attachmentState.addFiles(filesWithPath);
    // The file is an attachment, not text; text in the same paste is dropped, as in a task.
    if (handled) event.preventDefault();
  };

  const stop = async () => {
    if (stoppingRef.current) return;
    const api = botGroupApi();
    if (!api) return;
    stoppingRef.current = true;
    setStopping(true);
    try {
      const result = await api.stopBotGroupRound(groupId);
      if (!result.ok) toast.error(t('bots.groupChat.composer.stopFailed'));
    } catch {
      toast.error(t('bots.groupChat.composer.stopFailed'));
    } finally {
      stoppingRef.current = false;
      setStopping(false);
    }
  };

  const hint = !hasMembers
    ? t('bots.groupChat.composer.noMembers')
    : tooLong
      ? t('bots.groupChat.composer.tooLong', { max: BOT_GROUP_MESSAGE_MAX_CHARS })
      : tooManyAttachments
        ? t('bots.groupChat.composer.tooManyAttachments', { max: BOT_GROUP_ATTACHMENTS_MAX })
        : null;
  const actionLabel = showStop ? t('bots.groupChat.composer.stop') : t('bots.send');
  const moreLabel = t('bots.groupChat.composer.more');
  const removeDivisionLabel = t('bots.groupChat.composer.removeDivision');
  const placeholder = !hasMembers
    ? t('bots.groupChat.composer.noMembers')
    : division
      ? t('bots.groupChat.composer.placeholderDivision')
      : planState?.kind === 'proposed'
        ? t('bots.groupChat.composer.placeholderPlanProposed')
        : planState?.kind === 'running' && planState.botName
          ? t('bots.groupChat.composer.placeholderPlanRunning', { name: planState.botName })
          : planState?.kind === 'waiting' && planState.stepDone && planState.botName
            ? t('bots.groupChat.composer.placeholderPlanWaiting', { name: planState.botName })
            : t('bots.groupChat.composer.placeholder');

  return (
    <div className={BOT_GROUP_COMPOSER_DOCK}>
      <div className={BOT_GROUP_COMPOSER_COLUMN}>
        {/* Same floating slot above the card as a task's composer: files that did not attach. */}
        {attachmentState.rejections.length > 0 ? (
          <div className="pointer-events-none absolute bottom-full left-0 right-0 z-20 mb-2 flex flex-col items-center gap-1 px-3">
            <AttachmentRejectionStrip
              rejections={attachmentState.rejections}
              onDismiss={attachmentState.dismissRejection}
            />
          </div>
        ) : null}
        {mention.list}
        <div className={BOT_GROUP_COMPOSER_CARD}>
          {dragOver ? (
            <div
              data-testid="bot-group-drop-hint"
              className="pointer-events-none absolute inset-0 z-10 rounded-[12px]"
              style={{
                backgroundColor: 'var(--drop-overlay-bg)',
                border: '2px dashed var(--drop-overlay-border)',
              }}
            />
          ) : null}
          {division ? (
            <div className="flex">
              <span
                data-testid="bot-group-division-tag"
                className="inline-flex h-6 select-none items-center gap-1 rounded-full bg-[var(--surface-chip)] pl-2 pr-0.5 text-12 font-medium text-[var(--text-primary)]"
              >
                <Users size={12} aria-hidden className="text-[var(--text-secondary)]" />
                {t('bots.groupChat.composer.divisionTag')}
                <Tip text={removeDivisionLabel}>
                  <button
                    type="button"
                    aria-label={removeDivisionLabel}
                    onClick={() => {
                      setDivision(false);
                      textareaRef.current?.focus();
                    }}
                    className="flex h-5 w-5 items-center justify-center rounded-full text-[var(--text-tertiary)] outline-none transition-colors hover:bg-[var(--button-primary-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                  >
                    <X size={12} />
                  </button>
                </Tip>
              </span>
            </div>
          ) : null}
          {quote && onQuoteChange ? (
            <BotGroupQuotePreview
              display={quote.display}
              onRemove={() => {
                onQuoteChange(null);
                textareaRef.current?.focus();
              }}
            />
          ) : null}
          {attachmentCount > 0 ? (
            <ThumbnailStrip
              attachments={attachmentState.attachments}
              onRemove={attachmentState.removeFile}
              onUpdate={attachmentState.updateFile}
            />
          ) : null}
          <textarea
            ref={textareaRef}
            value={text}
            rows={1}
            aria-label={t('bots.groupChat.composer.label')}
            {...mention.textareaProps}
            placeholder={placeholder}
            onChange={(event) => mention.onChange(event.target.value)}
            onPaste={handlePaste}
            onKeyDown={(event) => {
              if (isComposingKey(event)) return;
              if (mention.onKeyDown(event)) return;
              // Esc takes the quote off before anything else it would close; the text stays.
              if (event.key === 'Escape' && quote && onQuoteChange) {
                event.preventDefault();
                onQuoteChange(null);
                return;
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                send();
                return;
              }
              // Backspace at the very start of an empty input takes the 「分工」 tag off.
              if (event.key === 'Backspace' && division && !text) {
                event.preventDefault();
                setDivision(false);
              }
            }}
            className={BOT_GROUP_COMPOSER_INPUT}
          />
          <div className={BOT_GROUP_COMPOSER_FOOTER}>
            <div className={BOT_GROUP_COMPOSER_FOOTER_START}>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = '';
                  if (files.length > 0) void attachmentState.addFiles(files);
                }}
              />
              <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
                <DropdownMenuTrigger asChild>
                  <Tip text={moreLabel}>
                    <button
                      type="button"
                      aria-label={moreLabel}
                      className={cn(
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] outline-none transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
                        menuOpen && 'bg-[var(--surface-chip)] text-[var(--text-primary)]',
                      )}
                    >
                      <Plus size={16} />
                    </button>
                  </Tip>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="start"
                  sideOffset={8}
                  className="w-72"
                  onCloseAutoFocus={(event) => {
                    if (!focusInputOnMenuCloseRef.current) return;
                    focusInputOnMenuCloseRef.current = false;
                    event.preventDefault();
                    textareaRef.current?.focus();
                  }}
                >
                  <DropdownMenuItem
                    className={cn(MENU_ITEM_CLASS, 'gap-2.5')}
                    onSelect={() => {
                      focusInputOnMenuCloseRef.current = true;
                      fileInputRef.current?.click();
                    }}
                  >
                    <Paperclip size={16} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
                    <span className="min-w-0 truncate">
                      {t('extraDirs.addFiles')}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={divisionBlocked}
                    className={cn(MENU_ITEM_CLASS, 'h-auto items-start gap-2.5 py-2')}
                    onSelect={() => {
                      focusInputOnMenuCloseRef.current = true;
                      setDivision(true);
                    }}
                  >
                    <Users size={16} aria-hidden className="mt-0.5 shrink-0 text-[var(--text-secondary)]" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span>
                        {t('bots.groupChat.composer.division')}
                      </span>
                      <span className="text-12 leading-[1.33] text-[var(--cmd-palette-item-meta)]">
                        {t(
                          divisionBlocked
                            ? 'bots.groupChat.composer.divisionBusy'
                            : 'bots.groupChat.composer.divisionDescription',
                        )}
                      </span>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <span className="min-w-0 truncate text-12 text-[var(--text-tertiary)]" aria-live="polite">
                {hint}
              </span>
            </div>
            <span className="inline-flex rounded-full" onMouseDown={keepBotGroupComposerInputFocus(textareaRef)}>
              <Tip text={actionLabel}>
                <SendButton
                  disabled={showStop ? stopping : !canSend}
                  isStreaming={showStop}
                  ariaLabel={actionLabel}
                  onClick={() => (showStop ? void stop() : send())}
                />
              </Tip>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
