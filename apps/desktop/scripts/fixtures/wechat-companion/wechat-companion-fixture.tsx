import { useState } from 'react';

import { BotChannelsPage } from '../../../src/renderer/features/bots/BotChannelsPage';
import type { BotProfile } from '../../../src/renderer/features/bots/botStore';
import { ImChannelSettingsCard } from '../../../src/renderer/components/settings/ImChannelSettingsCard';
import { Switch } from '../../../src/renderer/components/ui/switch';
import { mountPage, subscription, forbid } from '../../ui-page/harness';

function HeaderActionCard({ summary }: { summary: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const [enabled, setEnabled] = useState(false);
  return (
    <ImChannelSettingsCard
      id="fixture-action"
      title="Slack"
      description="Cindy channel"
      routeSummary={summary}
      status={<span role="status">Connected</span>}
      headerAction={<Switch aria-label="Enable Slack" checked={enabled} onCheckedChange={setEnabled} />}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
    >
      <span>Channel settings</span>
    </ImChannelSettingsCard>
  );
}

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
  render: (ctx) => <div className="mx-auto flex max-w-full flex-col gap-4 p-4"
    style={{ width: Number(ctx.data.cardWidth ?? 586) + 32 }}>
    <BotChannelsPage bot={{
      id: 'fixture-cindy', name: ctx.data.botName ?? 'Cindy', status: 'active',
    } as BotProfile} />
    {ctx.data.headerAction ? (
      <HeaderActionCard summary={typeof ctx.data.summary === 'string' ? ctx.data.summary : null} />
    ) : null}
  </div>,
});
