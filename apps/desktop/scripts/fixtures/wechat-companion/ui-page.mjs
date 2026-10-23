export default {
  name: 'wechat-companion',
  entry: './wechat-companion-fixture.tsx',
  viewport: { width: 620, height: 900 },
  real: 'BotChannelsPage, WechatBotSection, useWechatBot, existing connection accordion and translations',
  notCovered: 'Real account login, Tencent scan authorization, persisted binding and message delivery',
  cases: {
    default: { about: 'New WeChat connection for a teammate', data: {} },
    existing: { about: 'Reuse the already authorized personal WeChat connection', data: { bound: true } },
    assigned: { about: 'Connected teammate and remove-link action', data: { bound: true, companionBotId: 'fixture-cindy' } },
    other: { about: 'Another teammate owns this connection', data: { bound: true, companionBotId: 'fixture-other' } },
    'sidebar-394': {
      about: '#6706: 394px card in a wide window',
      viewport: { width: 1280, height: 900 },
      data: { bound: true, companionBotId: 'fixture-cindy', botName: 'Alfred', cardWidth: 394 },
    },
    'sidebar-320': {
      about: '320px card keeps summary, status and chevron visible',
      viewport: { width: 1280, height: 900 },
      data: { bound: true, companionBotId: 'fixture-cindy', cardWidth: 320 },
    },
    'wide-settings': {
      about: '760px settings card keeps a compact horizontal header',
      viewport: { width: 1280, height: 900 },
      data: { bound: true, companionBotId: 'fixture-cindy', cardWidth: 760 },
    },
    'long-name': {
      about: 'Long unbroken teammate name wraps without hiding the connected status',
      viewport: { width: 1280, height: 1000 },
      data: { bound: true, companionBotId: 'fixture-cindy', cardWidth: 394, botName: 'AlfredResearchAndEngineeringCompanionWithAVeryLongName' },
    },
    'header-action': {
      about: 'Independent sibling-channel switch and long route summary at 320px',
      viewport: { width: 1280, height: 1100 },
      data: { bound: true, companionBotId: 'fixture-cindy', cardWidth: 320, headerAction: true, summary: 'Claude Code · ALongUnbrokenProviderAndModelRouteSummaryForTheChannel' },
    },
    'header-action-empty': {
      about: 'Independent switch without a route summary in a wide settings card',
      viewport: { width: 1280, height: 900 },
      data: { cardWidth: 760, headerAction: true },
    },
    'sidebar-empty-320': {
      about: 'Review #6729: empty summary keeps status and chevron at the right edge after wrapping',
      viewport: { width: 1280, height: 900 },
      data: { cardWidth: 320 },
    },
    'header-action-empty-320': {
      about: 'Empty summary with an independent switch at 320px',
      viewport: { width: 1280, height: 900 },
      data: { cardWidth: 320, headerAction: true },
    },
    'header-action-empty-394': {
      about: 'Empty summary with an independent switch at 394px',
      viewport: { width: 1280, height: 900 },
      data: { cardWidth: 394, headerAction: true },
    },
  },
  // Browser/e2e regression for #6706. The existing jsdom unit test covers
  // accordion semantics but cannot detect flex shrink or viewport breakpoints.
  // Minimal failure: 394px assigned WeChat card inside a 1280px viewport.
  // Review regression: null summary at 320px; checking visibility alone misses
  // the wrapped status group jumping to the left. Measure the chevron's edge.
  async check(page, ui) {
    const trigger = page.locator('#companion-im-wechat-trigger');
    await trigger.getByRole('status').waitFor();
    if (ui.data.companionBotId === 'fixture-cindy') {
      await trigger.getByText(ui.data.botName ?? 'Cindy', { exact: true }).waitFor({ state: 'attached' });
    }
    const measureHeader = async (button) => button.evaluate((element) => {
      const text = element.firstElementChild;
      const title = text.firstElementChild;
      const range = document.createRange();
      range.selectNodeContents(title);
      const status = element.querySelector('[role=status]');
      const chevron = element.querySelector('svg');
      const bounds = element.getBoundingClientRect();
      const visible = (node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.left >= bounds.left && rect.right <= bounds.right;
      };
      const summary = text.nextElementSibling.firstElementChild;
      return {
        textWidth: text.getBoundingClientRect().width,
        titleLines: range.getClientRects().length,
        statusVisible: visible(status),
        chevronVisible: visible(chevron),
        summaryVisible: summary.contains(status) || summary === status || (visible(summary) && summary.scrollWidth <= summary.clientWidth + 1),
        textTop: text.getBoundingClientRect().top,
        statusTop: status.getBoundingClientRect().top,
        textBottom: text.getBoundingClientRect().bottom,
        trailingGap: bounds.right - parseFloat(getComputedStyle(element).paddingRight) - chevron.getBoundingClientRect().right,
      };
    });
    const assertHeader = async (button) => {
      const metrics = await measureHeader(button);
      if (metrics.textWidth < 160 || metrics.titleLines !== 1 || !metrics.statusVisible || !metrics.chevronVisible || !metrics.summaryVisible || Math.abs(metrics.trailingGap) > 1) {
        throw new Error(`Unreadable channel header: ${JSON.stringify(metrics)}`);
      }
      return metrics;
    };
    await ui.capture('collapsed');
    const metrics = await assertHeader(trigger);
    if (ui.case === 'wide-settings' && metrics.statusTop >= metrics.textBottom) {
      throw new Error('Wide settings card unnecessarily stacks its header');
    }
    await trigger.click();
    await page.locator('#companion-im-wechat-panel').waitFor();
    await assertHeader(trigger);
    await ui.capture('expanded');
    await trigger.click();
    if (await trigger.getAttribute('aria-expanded') !== 'false') throw new Error('Card did not collapse');
    if (ui.data.headerAction) {
      const actionTrigger = page.locator('#fixture-action-trigger');
      if (ui.data.summary) await actionTrigger.getByText(ui.data.summary, { exact: true }).waitFor({ state: 'attached' });
      const action = page.getByRole('switch', { name: 'Enable Slack' });
      await action.click();
      if (await action.getAttribute('aria-checked') !== 'true' || await actionTrigger.getAttribute('aria-expanded') !== 'false') {
        throw new Error('Independent header switch toggled the accordion or failed to enable');
      }
      await assertHeader(actionTrigger);
      await actionTrigger.click();
      await page.locator('#fixture-action-panel').waitFor();
      await assertHeader(actionTrigger);
      await ui.capture('header-action-expanded');
    }
  },
};
