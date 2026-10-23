/**
 * main/im/feishu/contactsAutoRegister.ts
 * ---------------------------------------------------------------------------
 * 飞书群多人对话的「记住每个人」①层(与 Telegram 同一条产品口径): 群历史里
 * 出现过的人自动登记进智能通讯录 — open_id 为身份, 显示名取自群历史 sender_name,
 * 建档带来源群名。零 LLM 成本; ②层(agent 在 turn 里用 contacts 工具写深度信息)
 * 走既有 cindy_contacts MCP, 不在本文件。
 *
 * 飞书与 Telegram 的差别:
 *  - 群里只有主人 @bot 才起 turn, 其他人的发言只存在于群历史里 — 所以登记
 *    入口是「本轮纳入上下文的历史发言人」, 不是触发消息的 speaker;
 *  - open_id 是 per-app 的, 不同 bot 应用下同一个人 open_id 不同, 去重键必须
 *    带上 appId, 身份 note 也记下来源应用。
 *
 * 边界:
 *  - 尊重通讯录总开关(关着 = 不写);
 *  - owner / bot 不登记;
 *  - 已有身份命中(feishu 平台 + open_id)不重复建档, 不覆盖任何既有信息;
 *  - 全程尽力而为 — 任何失败只 debug 日志, 绝不影响消息链路。
 */

import type { MakerContactsStore } from '@cindy/maker-core';

import { createLogger } from '../../logger.js';
import { emitLocalContactsChanged } from '../../maker-host/contacts-change-events.js';
import { getDesktopContactsManager } from '../../maker-host/maker-contacts-host.js';
import { readContactsSettingsState } from '../../maker-host/contacts-settings-store.js';

const log = createLogger('feishu-contacts-auto');

/** 进程内去重(同一人只探一次); 换账号/换 store 实例时整体失效。 */
const seen = new Set<string>();
let cachedStore: MakerContactsStore | null = null;

export interface FeishuSpeakerToRegister {
  openId: string;
  name: string;
  isBot?: boolean;
  isOwner?: boolean;
}

export interface FeishuSpeakerRegisterContext {
  /** 群名(拿不到时省略, 用「飞书群」)。 */
  chatName?: string | null;
  /** bot 应用 id — open_id 的作用域, 同时写进身份备注。 */
  appId: string;
  /** 渠道显示名(飞书 / Lark); 缺省飞书。 */
  platformLabel?: string;
}

/**
 * 把本轮群历史里出现过的成员登记进通讯录。调用方应在 turn 主链路之外
 * 调用; 函数自身同步执行且吞掉全部异常。
 */
export function autoRegisterFeishuSpeakers(
  speakers: readonly FeishuSpeakerToRegister[],
  context: FeishuSpeakerRegisterContext,
): void {
  if (speakers.length === 0) return;
  try {
    if (!readContactsSettingsState().value.enabled) return;
    const store = getDesktopContactsManager().getStore();
    if (store !== cachedStore) {
      seen.clear();
      cachedStore = store;
    }
    const label = context.platformLabel ?? '飞书';
    const groupNote = context.chatName ? label + '群「' + context.chatName + '」' : label + '群';
    for (const speaker of speakers) {
      if (speaker.isBot || speaker.isOwner) continue;
      const openId = speaker.openId.trim();
      if (!openId) continue;
      const key = context.appId + ':' + openId;
      if (seen.has(key)) continue;
      const hits = store.resolve(openId, { platform: 'feishu', limit: 1 });
      if (hits.some((h) => h.matchType === 'identity')) {
        seen.add(key);
        continue;
      }
      store.createContact({
        kind: 'person',
        displayName: speaker.name.trim() || openId,
        source: 'agent',
        summary: groupNote + '成员(bot 自动登记)',
        identities: [
          {
            platform: 'feishu',
            value: openId,
            note: context.appId ? 'app:' + context.appId : '',
          },
        ],
      });
      seen.add(key);
      emitLocalContactsChanged();
      log.info('auto-registered feishu speaker app=' + context.appId + ' id=' + openId);
    }
  } catch (err) {
    log.debug?.(
      'feishu contact auto-register skipped: ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/** 账号切换时清空进程内去重(store 实例比对之外的显式边界)。 */
export function resetFeishuSpeakerRegistrationCache(): void {
  seen.clear();
  cachedStore = null;
}

