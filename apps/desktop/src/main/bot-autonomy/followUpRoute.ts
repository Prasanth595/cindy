/**
 * 伙伴跟进时「换哪个模型」的建议(get_task_digest 的 suggested_route)。
 *
 * 伙伴照建议用 set_session_runtime 代主人换模型，没有用户确认，也不会先交接重建上下文，
 * 所以只在换过去确实有用、且换过去装得下时给建议；其余情况不给，由伙伴提醒主人。
 * 规则见 docs/product-rules/cindy-bots-runtime.md §6.3。
 */
import type { TaskDigestFailure } from '../mcp-integrations/taskDigest.js';
import { decideProviderGroupFailure } from '../provider-group/failurePolicy.js';
import {
  botModelRouteIndex,
  nextBotModelRoute,
  normalizeBotModelChain,
  type BotModelRoute,
} from '../../shared/botModelChain.js';
import { agentSwitchKeepsContextHeadroom } from '../../shared/modelSwitchAssessment.js';

export interface FollowUpRouteInput {
  /** 调用方伙伴的有效候选链。 */
  chain: unknown;
  current: Pick<BotModelRoute, 'harness' | 'model' | 'providerId'>;
  failure: TaskDigestFailure;
  /** 这件任务已经试过的路线(runtime key)。 */
  visitedRoutes: readonly string[];
  /** SSH 远端任务不能跨 harness 切换(与候选链自动恢复同一口径)。 */
  sameHarnessOnly: boolean;
  /** 任务当前上下文用量(tokens);未知为 0。 */
  contextTokens: number;
  /** 任务当前路线的上下文窗口;未知为 null。 */
  currentContextWindow: number | null;
  /** 候选路线核实过的上下文窗口;未知为 null。 */
  windowOf(route: BotModelRoute): number | null;
}

export function suggestFollowUpRoute(input: FollowUpRouteInput): BotModelRoute | null {
  // 换模型救不了的失败(工具循环、上下文超限、请求本身无效、内容被拒等)不给建议,
  // 与供应商组「换到哪台都一样就不换」同一判定；没有可判断的错误时也不猜。
  if (input.failure.phase === 'errored') {
    const decision = decideProviderGroupFailure(
      {
        message: input.failure.error ?? '',
        ...(input.failure.errorReason ? { reason: input.failure.errorReason } : {}),
      },
      'run',
    );
    if (decision.action === 'stay') return null;
  }
  const chain = normalizeBotModelChain(input.chain);
  // 任务当前路线不在伙伴候选链里(主人自己选的模型)：伙伴的链不是这件任务的备选，不建议换。
  if (botModelRouteIndex(chain, input.current) < 0) return null;
  return nextBotModelRoute(
    chain,
    input.current,
    input.visitedRoutes,
    (candidate) =>
      (!input.sameHarnessOnly || candidate.harness === input.current.harness)
      // 换过去就挤满的小窗口路线不推荐。
      && agentSwitchKeepsContextHeadroom({
        contextTokens: input.contextTokens,
        currentContextWindow: input.currentContextWindow,
        targetContextWindow: input.windowOf(candidate),
      }),
  );
}
