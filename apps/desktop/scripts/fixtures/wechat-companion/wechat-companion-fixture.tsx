import { BotChannelsPage } from '../../../src/renderer/features/bots/BotChannelsPage';
import type { BotProfile } from '../../../src/renderer/features/bots/botStore';
import { mountPage, subscription, forbid } from '../../ui-page/harness';

mountPage({
  host: (ctx) => ({
    botImConnection: {
      list: async () => ({ connections: [] }),
      onChanged: subscription('connections'),
    },
    maker: {
      imDefaultSettingsGet: async () => ({ agentKind: 'codex', agents: { codex: { model: 'gpt-6.1-sol' } } }),
    },
    wechatBot: {
      getState: async () => ({ phase: ctx.data.bound ? 'connected' : 'disconnected', bound: !!ctx.data.bound, queuedTasks: 0 }),
      getChannelSettings: async () => ({ version: 1, workingDir: null, workingDirAvailable: true, companionBotId: ctx.data.companionBotId }),
      onStateChange: subscription('wechatState'),
      onChannelSettingsChange: subscription('wechatSettings'),
      setCompanion: forbid('wechatBot.setCompanion'),
      authorize: forbid('wechatBot.authorize'),
      unbind: forbid('wechatBot.unbind'),
    },
  }),
  render: () => <div className="mx-auto max-w-2xl p-4"><BotChannelsPage bot={{
    id: 'fixture-cindy', name: 'Cindy', status: 'active',
  } as BotProfile} /></div>,
});
