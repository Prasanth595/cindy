import type { AgentIslandSessionActivity } from '../../../shared/agentIsland';
import type { BotGroupSummary } from '../../../shared/botGroupChat';
import { isBotGroupLaneSession } from './botGroupLane';
import {
  botGroupSidebarPlanPreview,
  isRunningBotGroupSidebarPreview,
} from './botGroupPresentation';
import type { BotProfile } from './botStore';

/**
 * 群聊行「需要用户回来处理」的单一判据。
 *
 * 与 `BotGroupSidebarRow` 第二行的提示完全同源：分工停在等开始 / 等继续 / 等重试，
 * 或某个发言 lane 进入 `needs-interaction`。这两类状态不一定产生未读消息，所以
 * 伙伴段收起行数以后，段尾的提醒必须复用这里 —— 否则被收起的群会连同提示一起消失。
 */
export function botGroupNeedsAttention(
  group: BotGroupSummary,
  bots: readonly BotProfile[],
  islandActivity: ReadonlyMap<string, AgentIslandSessionActivity>,
): boolean {
  const plan = botGroupSidebarPlanPreview(group);
  if (plan !== null && !isRunningBotGroupSidebarPreview(plan)) return true;

  return group.speakingBotIds.some((botId) => {
    const bot = bots.find((candidate) => candidate.id === botId);
    if (!bot) return false;
    return bot.sessions
      .filter(isBotGroupLaneSession)
      .some((session) => islandActivity.get(session.id)?.phase === 'needs-interaction');
  });
}
