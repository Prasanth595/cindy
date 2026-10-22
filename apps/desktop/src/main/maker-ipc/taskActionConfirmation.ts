import { t } from '../i18n.js';
import { ORCA_TASK_ACTION_TOOLS } from './taskActionAuthorization.js';

export interface TaskActionConfirmationCopy {
  title: string;
  description: string;
  action: { toolName: string; input: Record<string, unknown>; confirmation: 'task_action' };
}

/**
 * The owner-facing card for one exact Host-owned action (#6703).
 *
 * The card's title, description and tool name are Host facts: the Agent supplies only the
 * arguments of the call the gate already admitted, so it cannot label a write as something
 * else. Orca writes live under `cindy_orca`; presenting them as `cindy_helper` named a tool
 * that does not exist in the transcript.
 */
export function taskActionConfirmationCopy(
  tool: string,
  args: unknown,
): TaskActionConfirmationCopy {
  return {
    title: t('taskActionConfirmation.title'),
    description: t(
      tool === 'start_session_task'
        ? 'taskActionConfirmation.delegation'
        : 'taskActionConfirmation.once',
    ),
    action: {
      toolName: `mcp__${ORCA_TASK_ACTION_TOOLS.has(tool) ? 'cindy_orca' : 'cindy_helper'}__${tool}`,
      input: args as Record<string, unknown>,
      confirmation: 'task_action',
    },
  };
}
