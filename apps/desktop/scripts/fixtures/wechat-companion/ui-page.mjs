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
  },
  async check(page) {
    await page.locator('#companion-im-wechat-trigger').click();
  },
};
