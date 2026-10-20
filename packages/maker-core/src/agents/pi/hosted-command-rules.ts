import type { DeviceHostedSession } from '../base-agent.js';
import type { EvaluatePiCommandRules, PiCommandRuleEvaluation } from './command-rules.js';

/** Decisions come from the task's execution computer, never the Agent computer. */
export function hostedCommandRulesEvaluator(hosted: DeviceHostedSession): EvaluatePiCommandRules {
  return async (request) => {
    const check = async (): Promise<{ decision: PiCommandRuleEvaluation['decision']; revision: string; reason?: string }> => {
      const response = await fetch(hosted.tunnelUrl.replace(/\/+$/, '') + '/exec/pi.commandrules', {
        method: 'POST', headers: { authorization: `Bearer ${hosted.tunnelToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ command: request.command, cwd: request.evidence?.cwd ?? request.workingDir }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error('Execution computer command rules unavailable');
      const result = await response.json() as Record<string, unknown>;
      if (!['allow', 'prompt', 'forbidden', 'unmatched', 'error'].includes(String(result.decision))
        || typeof result.revision !== 'string') throw new Error('Invalid execution computer command rules response');
      return { decision: result.decision as PiCommandRuleEvaluation['decision'], revision: result.revision,
        ...(typeof result.reason === 'string' ? { reason: result.reason.slice(0, 1024) } : {}) };
    };
    try {
      const result = await check();
      return { ...result, isCurrent: async () => {
        try { const next = await check(); return next.revision === result.revision && next.decision === result.decision; }
        catch { return false; }
      } };
    } catch {
      return { decision: 'error', revision: '', reason: '执行电脑的命令规则组件暂不可用，请重试并确认两端 Cindy 均已更新。', isCurrent: async () => false };
    }
  };
}
