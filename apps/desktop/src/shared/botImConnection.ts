/**
 * 伙伴自有 IM 机器人连接的 IPC 线上类型(main / preload / renderer 共用)。
 *
 * 一位伙伴可以挂多个平台的机器人(Telegram、飞书 / Lark), 凭证由用户自己在平台申请,
 * 在伙伴设置「消息平台」页直接填; 与 设置 → IM 机器人 里那份独立的个人 bot 互不相干。
 * 主人私聊进伙伴主任务, 群 / 话题 / 外部用户私聊各一条隐藏专线。
 * 正本与语义见 main/im/shared/botImConnectionStore.ts 与 botImConnectionRuntime.ts。
 */

export const BOT_IM_CHANNELS = ['telegram', 'feishu'] as const;
export type BotImChannel = (typeof BOT_IM_CHANNELS)[number];

export type BotImFeishuService = 'feishu' | 'lark';

/** 与 @cindy/im 的 IMStatus 同形, 这里单独声明避免 renderer 依赖传输包类型。 */
export type BotImConnectionStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'connected'; appId: string }
  | { kind: 'conflict'; appId: string }
  | { kind: 'offline'; appId: string }
  | { kind: 'error'; reason: string; code?: string };

/** 落盘记录: 不含凭证, 凭证按连接 id 前缀存在本机安全存储里。 */
export interface BotImConnectionRecord {
  id: string;
  botId: string;
  channel: BotImChannel;
  createdAt: number;
  /** 飞书 / Lark 二选一(只有 feishu 渠道有)。 */
  service?: BotImFeishuService;
  /** 平台身份(Telegram bot id / 飞书 app id), 首次连上后记下, 用于专线 route key。 */
  botContextId: string | null;
}

export interface BotImConnectionView extends BotImConnectionRecord {
  status: BotImConnectionStatus;
  identity: {
    /** Telegram bot 用户名(连上后才有)。 */
    username: string | null;
    /** Telegram 主人用户 id。 */
    ownerUserId: string | null;
  };
}

export interface BotImConnectionListPayload {
  connections: BotImConnectionView[];
}

export type BotImConnectionAddInput =
  | { botId: string; channel: 'telegram'; token: string; ownerUserId: string }
  | {
      botId: string;
      channel: 'feishu';
      appId: string;
      appSecret: string;
      service: BotImFeishuService;
    };

export interface BotImConnectionAddResult extends BotImConnectionListPayload {
  connection: BotImConnectionView;
}

export interface BotImConnectionRemoveResult extends BotImConnectionListPayload {
  /** 随连接一起归档的隐藏专线任务。 */
  archivedSessionIds: string[];
}

export const BOT_IM_CONNECTION_CHANGED_EVENT = 'botImConnection:changed';
