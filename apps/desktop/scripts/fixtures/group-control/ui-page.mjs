import assert from 'node:assert/strict';

const members = [
  { botId: 'a', name: 'Aster' },
  { botId: 'b', name: 'Nova' },
];
const base = { name: 'Design review', members, messages: 0, sidebar: true };
const LONG_DEVICE = 'Mac Studio · A very long device name for layout verification';

/** Migrated from check-group-control-layout.mjs (remote-control notice above the composer). */
export default {
  name: 'group-chat',
  entry: './group-control-fixture.tsx',
  viewport: { width: 1280, height: 800 },
  real: 'BotGroupChatView (timeline, composer, send button, header registration), ControlledBanner, ContentHeader shell, Markdown, theme, fonts and translations',
  notCovered:
    'Sending, round control, real device-link control and revocation, pending interactions, plans and attachments; the bubbles case shows a task snapshot, not a live task; the sidebar is an empty frame',
  cases: {
    default: { about: 'Empty group, short controller name, expanded sidebar', data: base },
    'long-thread': {
      about: '40 messages: bottom pin and history position survive notice changes',
      viewport: { width: 800, height: 600 },
      data: { ...base, messages: 40 },
    },
    'long-device': {
      about: 'Long controller device name in the notice',
      data: base,
      controller: LONG_DEVICE,
    },
    multiline: { about: 'Eight-line draft pushes the composer up', data: base, lines: 8 },
    'no-sidebar': { about: 'Collapsed sidebar layout', data: { ...base, sidebar: false } },
    bubbles: {
      about: 'Teammate bubbles: quote, corner reaction, thread entry, task card, long text at the width cap; hover shows the toolbar beside the bubble',
      data: { ...base, bubbles: true },
    },
    'bubbles-wrapped': {
      about: 'PR #6549: wrapped reactions keep both toolbars level with their bubbles; server messages with empty mention ids still open unique member cards',
      viewport: { width: 800, height: 800 },
      data: { ...base, bubbles: true, wrappedReactions: true },
    },
  },
  async ready(page) {
    await page.locator('textarea').waitFor();
  },
  async check(page, ui) {
    const definition = this.cases[ui.case];
    const input = page.locator('textarea');
    const chip = page.locator('[data-controlled-banner-chip]');
    const collapsedDot = page.locator('[data-controlled-banner="collapsed"]');
    const scroller = page.getByTestId('bot-group-timeline');
    const connect = async (connected = true) => {
      const name = definition.controller ?? 'Mac Studio';
      assert.ok(
        await ui.emit('controlledState', {
          controllers: connected ? [{ deviceId: 'fixture', name }] : [],
        }),
        'banner subscribed to controlled state',
      );
      await chip.waitFor({ state: connected ? 'visible' : 'detached' });
    };
    const collapse = async () => {
      await page.locator('[data-controlled-banner-collapse]').click();
      await collapsedDot.waitFor();
      assert.equal(await chip.count(), 0);
    };
    const expand = async () => {
      await collapsedDot.click();
      await chip.waitFor();
    };

    if (ui.case.startsWith('bubbles')) {
      const answer = page.getByText('Android 更新卡那个 PR', { exact: false });
      await answer.waitFor();
      // Three recent responders stay visible; only the newest two summaries are spoken.
      const preview = page.locator('[data-thread-preview="a1"]');
      assert.equal(await preview.locator(':scope > span[aria-hidden="true"] > *').count(), 3);
      const description = await preview.getAttribute('aria-describedby');
      const summary = await page.locator(`[id="${description}"]`).textContent();
      assert.equal(summary.match(/You:/g)?.length, 2);
      assert.ok(!summary.includes('Aster:') && !summary.includes('Nova:'));
      // Older hosts omit responders: the existing replies-only preview still works.
      assert.equal(await page.locator('[data-thread-preview="q4"] > span[aria-hidden="true"] > *').count(), 3);
      const row = '[data-bot-group-message-id="a1"]';
      const toolbar = page.locator(`${row} [data-bot-group-message-actions]`);
      await answer.hover();
      await page.waitForFunction(
        (row) => getComputedStyle(document.querySelector(`${row} [data-bot-group-message-actions]`)).opacity === '1',
        row,
      );
      const geometry = await page.evaluate((row) => {
        const bar = document.querySelector(`${row} [data-bot-group-message-actions]`).getBoundingClientRect();
        const bubble = document.querySelector(`${row} [data-testid="bot-group-bubble"]`).getBoundingClientRect();
        const timeline = document.querySelector('[data-testid="bot-group-timeline"]').getBoundingClientRect();
        return { gap: bar.left - bubble.right, inside: bar.right <= timeline.right };
      }, row);
      assert.ok(geometry.gap >= 0 && geometry.gap <= 32, `toolbar sits beside the bubble (gap ${geometry.gap}px)`);
      assert.ok(geometry.inside, 'toolbar stays inside the timeline');
      assert.ok(await toolbar.isVisible());
      // Reactions wider than a short message's text stay over its own bubble and inside the timeline.
      const corners = await page.evaluate(() => ['a2', 'q3'].map((id) => {
        const row = `[data-bot-group-message-id="${id}"]`;
        const reactions = document.querySelector(`${row} [data-reaction-corner]`);
        const corner = reactions.getBoundingClientRect();
        const bubble = document.querySelector(`${row} [data-testid="bot-group-bubble"], ${row} [data-testid="bot-group-self-bubble"]`).getBoundingClientRect();
        const bar = document.querySelector(`${row} [data-bot-group-message-actions]`).getBoundingClientRect();
        const timeline = document.querySelector('[data-testid="bot-group-timeline"]').getBoundingClientRect();
        return { id, left: corner.left - bubble.left, right: corner.right - bubble.right, inside: corner.left >= timeline.left && corner.right <= timeline.right,
          toolbarTop: bar.top - bubble.top, wrapped: corner.height > reactions.firstElementChild.getBoundingClientRect().height };
      }));
      for (const c of corners) {
        assert.ok(c.inside, `${c.id} reactions stay inside the timeline`);
        assert.ok(c.left >= -12 && c.right <= 12, `${c.id} reactions stay over the bubble (${c.left}, ${c.right})`);
        assert.ok(Math.abs(c.toolbarTop) <= 1, `${c.id} toolbar aligns with bubble top (${c.toolbarTop}px)`);
        if (ui.case === 'bubbles-wrapped') assert.ok(c.wrapped, `${c.id} exercises multiple reaction rows`);
      }
      // r4324819612: the opposite of the long-root case — the entry is wider
      // than this short message's text, and must still share the bubble's left edge.
      const shortThread = await page.evaluate(() => {
        const row = document.querySelector('[data-bot-group-message-id="q3"]');
        const bubble = row.querySelector('[data-testid="bot-group-self-bubble"]').getBoundingClientRect();
        const preview = row.querySelector('[data-thread-preview]').getBoundingClientRect();
        const article = row.querySelector('article').getBoundingClientRect();
        const text = document.createRange();
        text.selectNodeContents(row.querySelector('[data-testid="bot-group-self-bubble"] p'));
        return { offset: preview.left - bubble.left, right: article.right - bubble.right,
          entryWiderThanText: preview.width > text.getBoundingClientRect().width };
      });
      assert.ok(shortThread.entryWiderThanText, 'short root exercises an entry wider than its text');
      assert.ok(Math.abs(shortThread.offset) <= 1, `short self thread entry aligns with bubble left (${shortThread.offset}px)`);
      assert.ok(Math.abs(shortThread.right) <= 1, `short self bubble stays right-aligned (${shortThread.right}px)`);
      // r4325061150: self-authored shares must also follow their wider siblings,
      // both when a share becomes a root and when only its reactions make it wider.
      for (const id of ['q4', 'q5']) {
        const shared = page.locator(`[data-bot-group-message-id="${id}"]`);
        await shared.scrollIntoViewIfNeeded();
        const geometry = await shared.evaluate(row => {
          const card = row.querySelector('figure').getBoundingClientRect();
          const entry = row.querySelector('[data-thread-preview]')?.getBoundingClientRect();
          const reactions = row.querySelector('[data-reaction-corner]')?.getBoundingClientRect();
          const article = row.querySelector('article').getBoundingClientRect();
          return { width: card.width, right: article.right - card.right,
            entryLeft: entry ? entry.left - card.left : null,
            reactionLeft: reactions ? reactions.left - card.left : null,
            reactionRight: reactions ? reactions.right - card.right : null };
        });
        assert.ok(geometry.width <= 560, 'shared reply keeps its existing width cap');
        assert.ok(Math.abs(geometry.right) <= 1, 'shared reply stays right-aligned');
        if (geometry.entryLeft !== null) assert.ok(Math.abs(geometry.entryLeft) <= 1, `shared root entry aligns with card (${geometry.entryLeft}px)`);
        if (geometry.reactionLeft !== null) {
          assert.ok(Math.abs(geometry.reactionLeft + 10) <= 1, `shared reply reactions stay on the left corner (${geometry.reactionLeft}px)`);
          assert.ok(geometry.reactionRight <= 1, 'shared reply reactions stay inside the card width');
        }
      }
      await ui.capture('shared-reply');
      await answer.hover();
      await ui.capture('hover');
      // A mention reads in the link color and, rested on, shows who it names.
      await page.locator('[data-bot-group-message-id="q2"]').scrollIntoViewIfNeeded();
      // PR #6549 r4323960180: a self-authored long root keeps its thread entry
      // at the bubble's left edge, while the message itself stays right-aligned.
      const thread = await page.evaluate(() => {
        const row = document.querySelector('[data-bot-group-message-id="q2"]');
        const bubble = row.querySelector('[data-testid="bot-group-self-bubble"]').getBoundingClientRect();
        const preview = row.querySelector('[data-thread-preview]').getBoundingClientRect();
        const article = row.querySelector('article').getBoundingClientRect();
        return { offset: preview.left - bubble.left, right: article.right - bubble.right, room: bubble.width - preview.width };
      });
      assert.ok(thread.room > 10, 'self bubble is wider than its thread entry');
      assert.ok(Math.abs(thread.offset) <= 1, `self thread entry aligns with bubble left (${thread.offset}px)`);
      assert.ok(Math.abs(thread.right) <= 1, `self message stays right-aligned (${thread.right}px)`);
      const mention = await page.evaluate(() => {
        const text = [...document.querySelectorAll('[data-bot-group-message-id="q2"] [data-testid="bot-group-self-bubble"] p')]
          .map((p) => [...p.childNodes].find((n) => n.nodeType === 3 && n.data.includes('@Nova'))).find(Boolean);
        const range = document.createRange();
        const at = text.data.indexOf('@Nova');
        range.setStart(text, at); range.setEnd(text, at + 5);
        const box = range.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      });
      await page.mouse.move(mention.x, mention.y);
      const card = page.locator('[data-bot-group-mention-card]');
      await card.waitFor();
      assert.ok((await card.textContent()).includes('Nova'), 'the mention card names Nova');
      await ui.capture('mention');
      return;
    }

    if (ui.case === 'long-thread') {
      const bottomGap = () =>
        scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
      await page.waitForFunction(() => {
        const el = document.querySelector('[data-testid="bot-group-timeline"]');
        return (
          el &&
          el.scrollHeight > el.clientHeight &&
          el.scrollHeight - el.clientHeight - el.scrollTop < 1
        );
      });
      for (const [step, action] of [
        ['connection', () => connect()],
        ['collapse', collapse],
        ['expand', expand],
        ['disconnection', () => connect(false)],
      ]) {
        await action();
        assert.ok((await bottomGap()) < 1, `${step} keeps the thread pinned to the bottom`);
      }
      const before = await scroller.evaluate((el) => {
        el.scrollTop = 180;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
        return el.scrollTop;
      });
      for (const [step, action] of [
        ['connection', () => connect()],
        ['collapse', collapse],
        ['expand', expand],
        ['disconnection', () => connect(false)],
      ]) {
        await action();
        assert.equal(
          await scroller.evaluate((el) => el.scrollTop),
          before,
          `${step} keeps history position`,
        );
      }
      await connect();
      await ui.capture('history');
      return;
    }

    await connect();
    await input.fill(
      Array(definition.lines ?? 1)
        .fill('Layout check only; never sent.')
        .join('\n'),
    );
    // BotGroupComposer labels its send button with bots.send (not the shared SendButton default).
    const sendLabel = await ui.t('bots.send');
    const layout = await page.evaluate((sendLabel) => {
      const notice = document.querySelector('[data-controlled-banner-chip]');
      const textarea = document.querySelector('textarea');
      const card = textarea.parentElement.getBoundingClientRect();
      const send = textarea.parentElement.querySelector(`button[aria-label="${sendLabel}"]`);
      const reachable = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      };
      const n = notice.getBoundingClientRect();
      return {
        centerDelta: Math.abs(n.x + n.width / 2 - card.x - card.width / 2),
        above: n.bottom <= card.y,
        reachable: [
          textarea,
          send,
          notice.querySelector('button'),
          notice.querySelector('[data-controlled-banner-collapse]'),
        ].map(reachable),
      };
    }, sendLabel);
    assert.ok(layout.centerDelta < 1, 'notice is centered on the composer');
    assert.ok(layout.above, 'notice sits above the composer');
    assert.deepEqual(
      Object.fromEntries(
        ['input', 'send', 'revoke', 'collapse'].map((name, i) => [name, layout.reachable[i]]),
      ),
      { input: true, send: true, revoke: true, collapse: true },
      `input, send ("${sendLabel}"), revoke and collapse are clickable`,
    );
    await ui.capture('connected');
    await collapse();
    const dot = await page.evaluate(() => {
      const el = document.querySelector('[data-controlled-banner="collapsed"]');
      const r = el.getBoundingClientRect();
      const card = document.querySelector('textarea').parentElement.getBoundingClientRect();
      return {
        centerDelta: Math.abs(r.x + r.width / 2 - card.x - card.width / 2),
        above: r.bottom <= card.y,
        reachable: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
      };
    });
    assert.ok(dot.centerDelta < 1 && dot.above && dot.reachable, 'collapsed indicator placement');
    await ui.capture('collapsed');
    await expand();
    // Reach the notice through normal tab order; both activation keys toggle it.
    const viaKeyboard = async (selector, key) => {
      await input.focus();
      await page.keyboard.press('Shift+Tab');
      const target = page.locator(selector);
      assert.ok(
        await target.evaluate(
          (el) =>
            el === document.activeElement &&
            Boolean(el.getAttribute('aria-label')) &&
            el.matches(':focus-visible') &&
            getComputedStyle(el).boxShadow !== 'none',
        ),
        `${selector} is keyboard reachable with visible focus`,
      );
      await page.keyboard.press(key);
    };
    for (const key of ['Enter', 'Space']) {
      await viaKeyboard('[data-controlled-banner-collapse]', key);
      await collapsedDot.waitFor();
      await viaKeyboard('[data-controlled-banner="collapsed"]', key);
      await chip.waitFor();
    }
    await input.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    assert.ok(
      await chip
        .locator('button')
        .first()
        .evaluate((el) => el === document.activeElement),
      'revoke is a separate tab stop',
    );
    assert.equal(await page.getByRole('dialog').count(), 0, 'folding never opens a dialog');
  },
};
