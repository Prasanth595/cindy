import {
  handoffReceiptDoneClientId,
  parseHandoffReceiptInputClientId,
} from '@cindy/maker-shared/handoff-receipt';
import { UI_ACTION_TRIGGER_PREFIX } from '@cindy/maker-shared/synthetic-trigger';

/**
 * send_to_session 完成回执的回投:目标任务消费带 `handoff-receipt:` clientId 的输入且
 * turn 正常结束后,向发起任务回投一条隐藏唤醒。回执不含对方回复正文(发起方用
 * get_chat_history 自取),确定性 clientId 保证重放/重试幂等。回执 clientId 前缀是
 * `handoff-receipt-done:`,不会再被完成钩子当作请求回执的输入 —— 循环抑制由前缀互斥保证。
 */
export interface HandoffReceiptSend {
  (params: {
    targetSessionId: string;
    dispatcherSessionId: string;
    message: string;
    persistedContent: string;
    clientId: string;
    forceQueue: boolean;
  }): Promise<{ ok: true } | { ok: false; errorCode: string; message: string }>;
}

export function buildHandoffReceiptMessage(params: {
  targetSessionId: string;
  inputClientId: string;
}): string {
  return [
    `[Handoff receipt] 任务 ${params.targetSessionId} 已处理完你用 send_to_session 发送的一条消息(消息 id: ${params.inputClientId})。本条不是用户消息。`,
    '回执不含对方回复正文;需要结果用 history 类目 get_chat_history(session_id: ' +
      `${params.targetSessionId}) 读取。回复用户时不要复述本条回执或内部 id。`,
  ].join('\n');
}

const MAX_ATTEMPTS = 3;

export function createHandoffReceiptSender(deps: {
  send: HandoffReceiptSend;
  /** 注入以便单测;缺省 1s×attempt 的真实退避。 */
  delay?: (ms: number) => Promise<void>;
  warn?: (message: string, details: Record<string, unknown>) => void;
}): (targetSessionId: string, inputClientIds: readonly string[]) => Promise<void> {
  const delay =
    deps.delay ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
  const warn = deps.warn ?? (() => {});
  return async (targetSessionId, inputClientIds) => {
    for (const inputClientId of inputClientIds) {
      const parsed = parseHandoffReceiptInputClientId(inputClientId);
      if (!parsed) continue;
      const message = buildHandoffReceiptMessage({ targetSessionId, inputClientId });
      const clientId = handoffReceiptDoneClientId(parsed.nonce);
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        // 确定性 clientId + messages 表 (sessionId, clientId) 唯一索引:重发不会产生第二条回执。
        const result = await deps
          .send({
            targetSessionId: parsed.dispatcherSessionId,
            dispatcherSessionId: targetSessionId,
            message,
            persistedContent: `${UI_ACTION_TRIGGER_PREFIX}${message}`,
            clientId,
            forceQueue: true,
          })
          .catch((error: unknown) => ({
            ok: false as const,
            errorCode: 'INTERNAL',
            message: error instanceof Error ? error.message : String(error),
          }));
        if (result.ok) break;
        if (attempt === MAX_ATTEMPTS - 1) {
          warn('handoff receipt was not delivered', {
            targetSessionId,
            dispatcherSessionId: parsed.dispatcherSessionId,
            inputClientId,
            errorCode: result.errorCode,
          });
        } else {
          await delay(1_000 * (attempt + 1));
        }
      }
    }
  };
}
