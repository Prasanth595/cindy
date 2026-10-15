// @vitest-environment jsdom
import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, createEvent, fireEvent, render as renderUI, screen, waitFor, within } from '@testing-library/react';
import { Tooltip } from '@/components/ui/tooltip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatInviteButton, ChatMessageActions } from '../ChatServerControls';
import { ChatInviteDialog } from '../ChatInviteDialog';
import { ChatThreadPanel } from '../ChatThreadPanel';
import type { BotGroupDetail, BotGroupMessageView } from '../../../../shared/botGroupChat';
import { shareSelectionStore } from '@/components/chat/shareSelectionStore';
import { queryShareableMessageIds, stripInteractiveElements } from '@/lib/shareConversationImage';

const mocks = vi.hoisted(() => ({
  status: vi.fn(), react: vi.fn(), thread: vi.fn(), reply: vi.fn(), createInvite: vi.fn(), previewInvite: vi.fn(), acceptInvite: vi.fn(),
  refresh: vi.fn(), ownerCurrent: true,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div> }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => null }));
vi.mock('../botGroupStore', () => ({ refreshBotGroups: mocks.refresh }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1, isDataOwnerGenerationCurrent: () => mocks.ownerCurrent, isDataOwnerPushCurrent: () => true,
}));
const k = (name: string) => `bots.groupChat.server.${name}`;
const message = { id: 'root', authorName: 'Human', content: 'Root message', reactions: [{ emoji: '👍', count: 2, me: true }] } as BotGroupMessageView;
const group = { id: 'room', members: [], messages: [message] } as unknown as BotGroupDetail;
const render = (ui: ReactNode) => renderUI(<Tooltip.Provider>{ui}</Tooltip.Provider>);
beforeEach(() => {
  vi.clearAllMocks(); mocks.ownerCurrent = true;
  shareSelectionStore.reset();
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  mocks.status.mockResolvedValue({ enabled: true, connected: true });
  mocks.react.mockResolvedValue({ ok: true });
  mocks.thread.mockResolvedValue({ ok: true, root: message, replies: [], hasMore: false });
  mocks.createInvite.mockResolvedValue({ ok: true, link: 'cindy://chat-invite/test', expiresAt: '' });
  mocks.previewInvite.mockResolvedValue({ ok: true, groupId: 'room', name: 'Invited group', inviterName: 'Host' });
  mocks.acceptInvite.mockResolvedValue({ ok: true, groupId: 'room' });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: {
    chatServer: mocks, onBotGroupChanged: () => () => {},
  } } });
});
afterEach(() => { cleanup(); shareSelectionStore.reset(); vi.unstubAllGlobals(); });

describe('chat interaction controls', () => {
  it('focuses the close button when the archived thread reply input is disabled', () => {
    render(<ChatThreadPanel group={{ ...group, archived: true }} rootId="root" onClose={vi.fn()} />);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'bots.close' }));
  });

  it('refits a typed thread reply when the panel width changes, not when only its height does', () => {
    const observed: Array<{ target: Element; callback: () => void }> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(private callback: () => void) {}
      observe(target: Element) { observed.push({ target, callback: this.callback }); }
      disconnect() {}
    });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: k('replyPlaceholder') }) as HTMLTextAreaElement;
    let width = 400, contentHeight = 48;
    Object.defineProperty(input, 'clientWidth', { configurable: true, get: () => width });
    Object.defineProperty(input, 'scrollHeight', { configurable: true, get: () => contentHeight });
    fireEvent.change(input, { target: { value: 'A long reply that wraps onto several lines' } });
    expect(input.style.height).toBe('48px');
    const refit = observed.find(entry => entry.target === input)!.callback;
    width = 200; contentHeight = 96;
    refit();
    expect(input.style.height).toBe('96px');
    contentHeight = 120;
    refit();
    expect(input.style.height).toBe('96px');
  });

  it('keeps a sending thread reply focused and locked, then sends it only once', async () => {
    let settle: (value: { ok: true; messageId: string }) => void = () => {};
    mocks.reply.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: k('replyPlaceholder') }) as HTMLTextAreaElement;
    const sendButton = screen.getByRole('button', { name: k('sendReply') }) as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'In flight' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(input.readOnly).toBe(true));
    expect(document.activeElement).toBe(input);
    expect(sendButton.disabled).toBe(true);
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.click(sendButton);
    expect(mocks.reply).toHaveBeenCalledOnce();
    settle({ ok: true, messageId: 'reply' });
    await waitFor(() => expect(input.value).toBe(''));
    expect(input.readOnly).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('keeps the caret in the reply when the send button is pressed with the mouse', () => {
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: k('replyPlaceholder') }) as HTMLTextAreaElement;
    const sendButton = screen.getByRole('button', { name: k('sendReply') });
    fireEvent.change(input, { target: { value: 'Clicked send' } });
    input.focus();
    // A cancelled mousedown is what stops Chromium moving focus onto the button.
    expect(fireEvent.mouseDown(sendButton)).toBe(false);
    input.blur();
    expect(fireEvent.mouseDown(sendButton)).toBe(true);
  });

  it('closes from the square button surface outside the icon and retains the standard focus treatment', () => {
    const onClose = vi.fn();
    render(<ChatThreadPanel group={group} rootId="root" onClose={onClose} />);
    const close = screen.getByRole('button', { name: 'bots.close' });
    expect(close.className).toContain('w-8 rounded-none px-0');
    expect(close.className).toContain('[&::before]:rounded-full');
    expect(close.className).toContain('focus-visible:ring-2');
    expect(close.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    fireEvent.click(close, { clientX: 1, clientY: 1 });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([undefined, 'private-diagnostic'])('keeps existing thread notices visible without a valid runtime code: %s', async runtimeFailureCode => {
    mocks.thread.mockResolvedValue({ ok: true, root: message, replies: [{ ...message, id: 'old-notice', kind: 'notice',
      content: 'Existing system notice', runtimeFailureCode }], hasMore: false });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    expect(await screen.findByText('Existing system notice')).toBeTruthy();
    expect(screen.queryByText('private-diagnostic')).toBeNull();
  });

  it('renders the current root failure beside the root and removes it when a refreshed page clears the failure', async () => {
    const failure = { executionId: 'root-run', epoch: 1, sourceMessageId: message.id, botId: 'bot', botName: 'Bot', code: 'QUOTA_EXCEEDED', planId: null };
    mocks.thread.mockResolvedValueOnce({ ok: true, root: message, executionFailures: [failure], replies: [], hasMore: true })
      .mockResolvedValue({ ok: true, root: message, executionFailures: [], replies: [], hasMore: false });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const text = 'bots.groupChat.notice.runtimeFailure.QUOTA_EXCEEDED';
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.getByText('Root message')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await waitFor(() => expect(screen.queryByText(text)).toBeNull());
    expect(screen.getByText('Root message')).toBeTruthy();
  });

  it('clears a retried failure on an older loaded Thread page without dropping its reply', async () => {
    const latest = { ...message, id: 'latest', sequence: 100, content: 'Latest reply' };
    const older = { ...message, id: 'older', sequence: 4, content: 'Earlier reply' };
    const failure = { executionId: 'older-run', epoch: 1, sourceMessageId: older.id, botId: 'bot', botName: 'Bot', code: 'AUTH_REQUIRED', planId: null };
    mocks.thread.mockResolvedValueOnce({ ok: true, root: message, replies: [latest], hasMore: true, executionFailures: [failure] })
      .mockResolvedValueOnce({ ok: true, root: message, replies: [older], hasMore: false, executionFailures: [failure] })
      .mockResolvedValue({ ok: true, root: message, replies: [latest], hasMore: true, executionFailures: [] });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.loadEarlier' }));
    await screen.findByText('bots.groupChat.notice.runtimeFailure.AUTH_REQUIRED');
    const root = screen.getByText('Root message').closest('article')!;
    fireEvent.click(within(root).getByRole('button', { name: k('reactionCount') }));
    await waitFor(() => expect(screen.queryByText('bots.groupChat.notice.runtimeFailure.AUTH_REQUIRED')).toBeNull());
    expect(screen.getByText('Earlier reply')).toBeTruthy();
    expect(screen.getByText('Latest reply')).toBeTruthy();
    expect(mocks.thread.mock.calls.at(-1)?.[0]).toMatchObject({ sourceMessageIds: [older.id, latest.id] });
  });

  it('preserves copy and image sharing beside thread replies and reactions in one toolbar', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined), reply = vi.fn();
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<ChatMessageActions shareScope="group:room" groupId="room" message={{ ...message, replyCount: 2 }} onReply={reply} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'chat.messageActionBar.copy' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Root message'));
    fireEvent.click(screen.getByRole('button', { name: k('openTopic') }));
    expect(reply).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'chat.shareImage.entry' }));
    expect(shareSelectionStore.isActive('group:room')).toBe(true);
    expect(shareSelectionStore.getSelectedIds()).toEqual(['root']);
    fireEvent.click(screen.getByRole('button', { name: k('addReaction') }));
    fireEvent.click(screen.getByRole('button', { name: '🎉' }));
    await waitFor(() => expect(mocks.react).toHaveBeenCalledWith({ groupId: 'room', messageId: 'root', emoji: '🎉', present: true }));
  });

  it('shares thread messages separately from the main timeline and excludes controls from the image', async () => {
    const view = render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const article = (await screen.findByText('Root message')).closest('article')!;
    fireEvent.click(within(article).getByRole('button', { name: 'chat.shareImage.entry' }));
    const scope = 'bot-group:room:thread:root';
    expect(shareSelectionStore.isActive(scope)).toBe(true);
    expect(queryShareableMessageIds(scope)).toEqual(['root']);
    expect(queryShareableMessageIds('bot-group:room')).toEqual([]);
    expect(screen.queryByRole('textbox', { name: k('replyPlaceholder') })).toBeNull();
    expect(screen.getByRole('button', { name: 'chat.shareImage.copy' })).toBeTruthy();
    const clone = article.cloneNode(true) as HTMLElement;
    stripInteractiveElements(clone);
    expect(clone.textContent).toContain('Human');
    expect(clone.textContent).toContain('Root message');
    expect(clone.querySelector('button')).toBeNull();
    view.unmount();
    expect(shareSelectionStore.getActiveSessionId()).toBeNull();
  });

  it('removes only the current actor reaction and refreshes the authoritative message', async () => {
    const changed = vi.fn();
    render(<ChatMessageActions shareScope="group:room" groupId="room" message={message} onChanged={changed} />);
    const reaction = screen.getByRole('button', { name: k('reactionCount') });
    expect(reaction.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(reaction);
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(mocks.react).toHaveBeenCalledWith({ groupId: 'room', messageId: 'root', emoji: '👍', present: false });
  });

  it('uses the refreshed Thread root reaction state while the main timeline remains stale', async () => {
    mocks.thread.mockResolvedValueOnce({ ok: true, root: message, replies: [], hasMore: false })
      .mockResolvedValue({ ok: true, root: { ...message, reactions: [{ emoji: '👍', count: 1, me: false }] }, replies: [], hasMore: false });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const reaction = await screen.findByRole('button', { name: k('reactionCount') });
    expect(reaction.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(reaction);
    await waitFor(() => expect(screen.getByRole('button', { name: k('reactionCount') }).getAttribute('aria-pressed')).toBe('false'));
    expect(screen.getByRole('button', { name: k('reactionCount') }).textContent).toContain('1');
    expect(group.messages[0].reactions?.[0].me).toBe(true);
  });

  it('shows a pasted invitation preview first; only explicit acceptance joins', async () => {
    const joined = vi.fn();
    render(<StrictMode><ChatInviteDialog onClose={vi.fn()} onJoined={joined} /></StrictMode>);
    expect(mocks.previewInvite).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: k('inviteLink') }), { target: { value: 'cindy://chat-invite/test' } });
    fireEvent.click(screen.getByRole('button', { name: k('previewInvite') }));
    await screen.findByText('Invited group');
    expect(mocks.acceptInvite).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: k('accept') }));
    await waitFor(() => expect(joined).toHaveBeenCalledWith('room'));
  });

  it('creates and displays a copyable link in Strict Mode', async () => {
    render(<StrictMode><ChatInviteButton groupId="room" /></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: k('invite') }));
    fireEvent.click(screen.getByRole('button', { name: k('createLink') }));
    expect((await screen.findByRole('textbox', { name: k('inviteLink') }) as HTMLInputElement).value).toBe('cindy://chat-invite/test');
  });

  it.each([{ members: [] }, { members: [{ botId: 'namesake', name: 'Ann', status: 'active' as const }] }])('keeps a refused directed thread reply after the roster changes to %j', async ({ members }) => {
    mocks.reply.mockResolvedValue({ ok: false, errorCode: 'MENTION_UNAVAILABLE' });
    const view = render(<ChatThreadPanel group={{ ...group, members: [{ botId: 'bot', name: 'Ann', status: 'active' }] } as BotGroupDetail} rootId="root" onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: k('replyPlaceholder') }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@Ann hello' } });
    fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
    expect((await screen.findByRole('alert')).textContent).toBe('bots.groupChat.errors.mentionUnavailable');
    expect(input.value).toBe('@Ann hello');
    expect(mocks.reply).toHaveBeenCalledWith(expect.objectContaining({ mentions: { all: false, botIds: ['bot'] } }));
    const original = mocks.reply.mock.calls[0]![0];
    view.rerender(<Tooltip.Provider><ChatThreadPanel group={{ ...group, members } as BotGroupDetail} rootId="root" onClose={vi.fn()} /></Tooltip.Provider>);
    fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledTimes(2));
    expect(mocks.reply.mock.calls[1]![0]).toEqual(original);
    expect(input.value).toBe('@Ann hello');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.change(input, { target: { value: '@Ann hello' } });
    mocks.reply.mockResolvedValue({ ok: true, messageId: 'accepted' });
    fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
    await waitFor(() => expect(mocks.reply).toHaveBeenCalledTimes(3));
    expect(mocks.reply.mock.calls[2]![0].mentions).toEqual({ all: false, botIds: members.map(member => member.botId) });
    expect(mocks.reply.mock.calls[2]![0].clientId).not.toBe(original.clientId);
  });

  it('keeps a failed reply draft and reuses its operation id; IME confirmation does not send', async () => {
    mocks.reply.mockResolvedValueOnce({ ok: false, errorCode: 'REQUEST_TIMEOUT' }).mockResolvedValueOnce({ ok: true, messageId: 'reply' });
    render(<ChatThreadPanel group={group} rootId="root" onClose={vi.fn()} />);
    const input = screen.getByRole('textbox', { name: k('replyPlaceholder') });
    fireEvent.change(input, { target: { value: 'A thread reply' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(mocks.reply).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
    await screen.findByRole('alert');
    expect((input as HTMLTextAreaElement).value).toBe('A thread reply');
    fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
    expect(mocks.reply.mock.calls[0][0].clientId).toBe(mocks.reply.mock.calls[1][0].clientId);
    expect(mocks.reply.mock.calls[0][0].rootId).toBe('root');
  });

  describe('thread @ picker', () => {
    const namesakes = [
      { botId: 'ann-chris', name: 'Ann', status: 'active' },
      { botId: 'ann-dana', name: 'Ann', status: 'active' },
      { botId: 'bo', name: 'Bo', status: 'active' },
      { botId: 'gone', name: 'Annie', status: 'left' },
    ];
    const renderThread = () => {
      mocks.reply.mockResolvedValue({ ok: true, messageId: 'reply' });
      render(<ChatThreadPanel group={{ ...group, members: namesakes } as unknown as BotGroupDetail} rootId="root" onClose={vi.fn()} />);
      const input = screen.getByRole('textbox', { name: k('replyPlaceholder') }) as HTMLTextAreaElement;
      expect(document.activeElement).toBe(input);
      return input;
    };
    const type = (input: HTMLTextAreaElement, value: string, caret = value.length) =>
      fireEvent.change(input, { target: { value, selectionStart: caret, selectionEnd: caret } });
    const labels = () => screen.queryAllByRole('option').map(option => option.textContent);

    it('opens on @ with the main composer candidates, filters, and picks a namesake by keyboard', async () => {
      const input = renderThread();
      type(input, '@');
      const listbox = screen.getByRole('listbox', { name: 'bots.groupChat.mention.label' });
      // Everyone first, then active teammates only (the departed one is not offered).
      expect(labels()).toEqual(['bots.groupChat.mention.allbots.groupChat.mention.allHint', 'Ann', 'Ann', 'Bo']);
      expect(input.getAttribute('aria-controls')).toBe(listbox.id);
      expect(input.getAttribute('aria-activedescendant')).toBe(screen.getAllByRole('option')[0]!.id);
      type(input, '@an');
      expect(labels()).toEqual(['Ann', 'Ann']);
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(screen.getAllByRole('option')[1]!.getAttribute('aria-selected')).toBe('true');
      // Enter picks while the list is open; it never sends.
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(input.value).toBe('@Ann ');
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(mocks.reply).not.toHaveBeenCalled();
      type(input, '@Ann 看一下');
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.reply).toHaveBeenCalledOnce());
      expect(mocks.reply.mock.calls[0]![0]).toMatchObject({ groupId: 'room', rootId: 'root', text: '@Ann 看一下', mentions: { all: false, botIds: ['ann-dana'] } });
      await waitFor(() => expect(input.value).toBe(''));
    });

    it('picks by mouse in the middle of a draft, supports several @ and Everyone', async () => {
      const input = renderThread();
      type(input, '请  帮忙', 1);
      type(input, '请 @ 帮忙', 3);
      const bo = screen.getAllByRole('option')[3]!;
      // Pressing the option keeps focus in the input.
      expect(fireEvent.mouseDown(bo)).toBe(false);
      fireEvent.click(bo);
      expect(input.value).toBe('请 @Bo 帮忙');
      expect(input.selectionStart).toBe(6);
      type(input, '请 @Bo @ 帮忙', 7);
      fireEvent.click(screen.getAllByRole('option')[0]!);
      expect(input.value).toBe('请 @Bo @bots.groupChat.mention.all 帮忙');
      fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
      await waitFor(() => expect(mocks.reply).toHaveBeenCalledOnce());
      expect(mocks.reply.mock.calls[0]![0].mentions).toEqual({ all: true, botIds: ['bo'] });
    });

    it('Escape closes only the list for that @; IME keys neither pick nor send', () => {
      const input = renderThread();
      type(input, '@');
      const composing = createEvent.keyDown(input, { key: 'Enter', isComposing: true, keyCode: 229 });
      fireEvent(input, composing);
      expect(input.value).toBe('@');
      expect(screen.getByRole('listbox')).toBeTruthy();
      const escape = createEvent.keyDown(input, { key: 'Escape' });
      fireEvent(input, escape);
      // The thread panel's own Esc-to-close sees a handled key and stays open.
      expect(escape.defaultPrevented).toBe(true);
      expect(screen.queryByRole('listbox')).toBeNull();
      type(input, '@A');
      expect(screen.queryByRole('listbox')).toBeNull();
      // Enter with the list closed sends as usual; a fresh @ opens it again.
      type(input, '@A @');
      expect(labels()).toHaveLength(4);
      fireEvent.keyDown(input, { key: 'Escape' });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(mocks.reply).toHaveBeenCalledOnce();
    });

    it('keeps the list closed while a reply is sending, so the read-only text cannot change', async () => {
      const input = renderThread();
      let settle: (value: { ok: true; messageId: string }) => void = () => {};
      mocks.reply.mockReturnValue(new Promise(resolve => { settle = resolve; }));
      type(input, '@B');
      expect(labels()).toContain('Bo');
      fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
      await waitFor(() => expect(input.readOnly).toBe(true));
      expect(screen.queryByRole('listbox')).toBeNull();
      fireEvent.keyDown(input, { key: 'Enter' });
      fireEvent.keyDown(input, { key: 'Tab' });
      expect(input.value).toBe('@B');
      settle({ ok: true, messageId: 'reply' });
      await waitFor(() => expect(input.value).toBe(''));
      expect(mocks.reply).toHaveBeenCalledOnce();
    });

    it('treats an e-mail address as text and forgets a pick once its name is edited', async () => {
      const input = renderThread();
      type(input, 'mail a@');
      expect(screen.queryByRole('listbox')).toBeNull();
      type(input, '@');
      fireEvent.click(screen.getAllByRole('option')[1]!);
      expect(input.value).toBe('@Ann ');
      type(input, '@An ', 3);
      type(input, '@Ann ', 4);
      fireEvent.keyDown(input, { key: 'Escape' });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.reply).toHaveBeenCalledOnce());
      // A retyped name is a manual @: both namesakes, as in the main composer.
      expect(mocks.reply.mock.calls[0]![0].mentions).toEqual({ all: false, botIds: ['ann-chris', 'ann-dana'] });
    });

    it('moves the caret past the space when a re-pick leaves the text unchanged, and does not pull it back later', () => {
      const input = renderThread();
      type(input, '@');
      fireEvent.click(screen.getAllByRole('option')[1]!);
      expect(input.selectionStart).toBe(5);
      act(() => { input.blur(); input.setSelectionRange(4, 4); input.focus(); });
      fireEvent.click(screen.getAllByRole('option')[1]!);
      expect(input.value).toBe('@Ann ');
      expect(input.selectionStart).toBe(5);
      type(input, '@Ann ok', 7);
      expect(input.selectionStart).toBe(7);
    });

    it('does not let a pick push the reply past its 8000-character limit', () => {
      const input = renderThread();
      const near = `${'x'.repeat(7996)} @`;
      type(input, near);
      fireEvent.click(screen.getAllByRole('option')[3]!);
      // `@Bo ` would make 8000 + 1 characters: the pick is refused, as typing past maxLength is.
      expect(input.value).toBe(near);
      type(input, `${'x'.repeat(7995)} @`);
      fireEvent.click(screen.getAllByRole('option')[3]!);
      expect(input.value).toBe(`${'x'.repeat(7995)} @Bo `);
      expect(input.value).toHaveLength(8000);
    });

    it('names only the picked companion whose name is a Thread 「所有人」 alias', async () => {
      mocks.reply.mockResolvedValue({ ok: true, messageId: 'reply' });
      const members = [{ botId: 'all-bot', name: 'all', status: 'active' }, { botId: 'bo', name: 'Bo', status: 'active' }];
      render(<ChatThreadPanel group={{ ...group, members } as unknown as BotGroupDetail} rootId="root" onClose={vi.fn()} />);
      const input = screen.getByRole('textbox', { name: k('replyPlaceholder') }) as HTMLTextAreaElement;
      type(input, '@al');
      fireEvent.click(screen.getAllByRole('option').find(option => option.textContent === 'all')!);
      expect(input.value).toBe('@all ');
      // Typing after the pick keeps it.
      type(input, '@all 看下');
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.reply).toHaveBeenCalledOnce());
      expect(mocks.reply.mock.calls[0]![0].mentions).toEqual({ all: false, botIds: ['all-bot'] });
    });

    it('never offers or resolves the current user, as on mobile', async () => {
      mocks.reply.mockResolvedValue({ ok: true, messageId: 'reply' });
      const members = [{ botId: 'me', name: 'Dash', status: 'active', isSelf: true }, { botId: 'bo', name: 'Bo', status: 'active' }];
      render(<ChatThreadPanel group={{ ...group, members } as unknown as BotGroupDetail} rootId="root" onClose={vi.fn()} />);
      const input = screen.getByRole('textbox', { name: k('replyPlaceholder') }) as HTMLTextAreaElement;
      type(input, '@');
      expect(labels()).toEqual(['bots.groupChat.mention.allbots.groupChat.mention.allHint', 'Bo']);
      type(input, '@Da');
      expect(screen.queryByRole('listbox')).toBeNull();
      // A typed own name is plain text, not a target the host would drop to nothing.
      type(input, '@Dash @Bo 看下');
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(mocks.reply).toHaveBeenCalledOnce());
      expect(mocks.reply.mock.calls[0]![0].mentions).toEqual({ all: false, botIds: ['bo'] });
    });

    // One retry rule (bot-group-chat.md): a failed reply is retried with the same clientId only when the
    // text and its targets are unchanged. Each row edits the draft between attempts without changing the text.
    // Comparing only the text fails rows 1 and 4; comparing the pick records fails row 3; re-resolving
    // against the live roster fails the roster-refresh test above.
    const pickAt = (input: HTMLTextAreaElement, caret: number, option: number) => {
      // As a user would: click back into the box with the caret after the name, then pick.
      act(() => { input.blur(); input.setSelectionRange(caret, caret); input.focus(); });
      fireEvent.click(screen.getAllByRole('option')[option]!);
    };
    it.each([
      { row: 're-pick the other namesake', draft: (input: HTMLTextAreaElement) => { type(input, '@'); fireEvent.click(screen.getAllByRole('option')[1]!); },
        edit: (input: HTMLTextAreaElement) => pickAt(input, 4, 1), text: '@Ann ', first: ['ann-chris'], second: ['ann-dana'], reused: false },
      { row: 're-pick the same teammate for an earlier mention', draft: (input: HTMLTextAreaElement) => {
        type(input, '@'); fireEvent.click(screen.getAllByRole('option')[1]!); type(input, '@Ann @', 6); fireEvent.click(screen.getAllByRole('option')[3]!);
      }, edit: (input: HTMLTextAreaElement) => pickAt(input, 4, 0), text: '@Ann @Bo ', first: ['ann-chris', 'bo'], second: ['ann-chris', 'bo'], reused: true },
      { row: 'pick the same teammate for a typed mention', draft: (input: HTMLTextAreaElement) => type(input, '@Bo '),
        // The typed query `Bo` also matches the untranslated 所有人 key here, so Bo is the second option.
        edit: (input: HTMLTextAreaElement) => pickAt(input, 3, 1), text: '@Bo ', first: ['bo'], second: ['bo'], reused: true },
      { row: 'pick one namesake for a typed mention', draft: (input: HTMLTextAreaElement) => type(input, '@Ann '),
        edit: (input: HTMLTextAreaElement) => pickAt(input, 4, 1), text: '@Ann ', first: ['ann-chris', 'ann-dana'], second: ['ann-dana'], reused: false },
    ])('retries a failed reply after "$row" with reused clientId = $reused', async ({ draft, edit, text, first, second, reused }) => {
      const input = renderThread();
      mocks.reply.mockResolvedValueOnce({ ok: false, errorCode: 'REQUEST_TIMEOUT' });
      draft(input);
      expect(input.value).toBe(text);
      fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
      await screen.findByRole('alert');
      edit(input);
      expect(input.value).toBe(text);
      fireEvent.click(screen.getByRole('button', { name: k('sendReply') }));
      await waitFor(() => expect(mocks.reply).toHaveBeenCalledTimes(2));
      const [one, two] = mocks.reply.mock.calls.map(call => call[0]);
      expect(one.mentions).toEqual({ all: false, botIds: first });
      expect(two.mentions).toEqual({ all: false, botIds: second });
      expect(two.clientId === one.clientId).toBe(reused);
    });
  });
});
