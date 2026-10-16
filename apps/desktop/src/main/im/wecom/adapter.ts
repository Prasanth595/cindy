import fs from 'node:fs';

import type { WecomIM } from '@cindy/im';
import { decodeWecomLane } from '@cindy/im';

import type { ImChannelAdapter, ImOrchestratorConfig } from '../shared/types';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage';
import { ui } from './uiText';
import type { WecomTextInteractions } from './textInteractions';

function ensureWorkingDir(botId: string): string {
  const safeBotId = Buffer.from(botId, 'utf8').toString('base64url').slice(0, 96);
  const dir = ownerScopedImUserDataPath('im-working-dir', `wecom-${safeBotId}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sessionSafeUserId(userId: string): string {
  return Buffer.from(userId, 'utf8').toString('base64url');
}

export interface WecomAdapterOptions {
  /** 伙伴自有连接: 主人私聊进伙伴主任务, 群按 lane 一条专线。 */
  companionBotId?: string;
}

export function buildWecomAdapter(
  wecomIm: WecomIM,
  interactions: WecomTextInteractions,
  config: ImOrchestratorConfig,
  options: WecomAdapterOptions = {},
): ImChannelAdapter {
  void options;
  return {
    channel: 'wecom',
    im: wecomIm,
    output: {
      kind: 'chunked-text',
      im: wecomIm,
      beginReply: (userId) => wecomIm.beginReply(userId),
      commitFinal: (output) => wecomIm.commitFinal(output),
    },
    config,
    ui,
    sessions: {
      source: 'wecom',
      sessionIdFor: (botId, userId) =>
        `wecom_${sessionSafeUserId(botId)}_${sessionSafeUserId(userId)}`,
      defaultTitle: (userId) =>
        userId.startsWith('group/')
          ? `企微群 · ${userId.slice(-6)}`
          : `企业微信 · ${userId.slice(-6)}`,
      generatedTitlePrefix: '企业微信 · ',
      workspaceKind: 'dialogue',
      ensureWorkingDir,
      extraInsertColumns: (botId, userId) => ({
        imBotContextId: botId,
        imUserId: userId,
      }),
    },
    processingEmoji: '',
    silentQueue: true,
    buildVendorOptions: (userId) => ({
      source: 'wecom',
      wecomConversationId: userId,
    }),
    // 伙伴自有连接: 企业微信传输层只放行 TOFU 主人(单聊首个发言人)的消息, 所以
    // 私聊一律是主人 → 伙伴主任务; 群(主人在群里 @)按 chat 一条专线。非主人私聊
    // 在传输层就被挡住, 这里仍按用户 id 判一次, 不靠「传输层一定挡住」。
    companionLane: (userId) => {
      let lane: ReturnType<typeof decodeWecomLane> | null = null;
      try {
        lane = decodeWecomLane(userId);
      } catch {
        lane = null;
      }
      if (lane?.kind === 'group') return { kind: 'group', chatId: lane.targetId, threadId: '' };
      const owner = wecomIm.getOwnerUserId();
      return owner && userId === owner ? { kind: 'owner-dm' } : { kind: 'guest-dm', userId };
    },
    handleTextInteraction: (userId, request, options) => interactions.handle(userId, request, options),
  };
}
