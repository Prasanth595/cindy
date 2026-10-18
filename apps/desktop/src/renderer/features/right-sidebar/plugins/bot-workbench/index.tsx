import { LayoutGrid } from 'lucide-react';
import { registerTabKind } from '../../registry';
import type { TabKindPlugin, TabKindBodyProps } from '../../types';
import { BotWorkbench } from '@/features/bots/BotWorkbench';

interface BotWorkbenchTabState {
  botId: string;
}

/**
 * 伙伴工作台「一眼」：伙伴主任务里的右侧栏标签，每个任务至多一个。伙伴第一次有事等主人时
 * 自动打开一次（BotSessionView）；之后关掉不再自动开，可从聊天头部入口或「+」菜单重新打开。
 * 内容只读宿主的 glance 投影：本机伙伴读本机，别的电脑上的伙伴经 device-link 读那台。
 * 任务归属尚未解析（deviceLinkDeviceId === undefined）或 SSH 远程任务不渲染。
 */
const plugin: TabKindPlugin<BotWorkbenchTabState> = {
  kind: 'bot-workbench',
  menu: {
    kind: 'bot-workbench',
    labelKey: 'bots.workbench.title',
    icon: LayoutGrid,
    order: 0,
    enabled: true,
    singleton: true,
  },
  TabPillTitle: ({ t }) => <>{t('bots.workbench.title')}</>,
  TabPillIcon: () => <LayoutGrid size={13} />,
  TabBody: ({ state, ctx }: TabKindBodyProps<BotWorkbenchTabState>) =>
    state.botId && ctx.deviceLinkDeviceId !== undefined && !ctx.remoteHostId ? (
      <BotWorkbench
        key={`${ctx.deviceLinkDeviceId ?? ''}:${state.botId}`}
        botId={state.botId}
        sessionId={ctx.sessionId}
        hostDeviceId={ctx.deviceLinkDeviceId}
      />
    ) : null,
  defaultState: () => ({ botId: '' }),
  hydrateState: (raw) => ({
    botId:
      raw && typeof raw === 'object' && typeof (raw as { botId?: unknown }).botId === 'string'
        ? (raw as { botId: string }).botId
        : '',
  }),
};
registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
