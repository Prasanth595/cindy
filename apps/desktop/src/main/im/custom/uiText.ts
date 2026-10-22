/** 自定义渠道的文案: 没有 slash / 卡片能力, 只保留最小命令集。 */

import type { ImUiTextPack } from '../shared/types';

export const ui: ImUiTextPack = {
  slash: {
    new: '/new',
    help: '/help',
    unknownCommand: (cmd: string) => `未知命令: ${cmd}`,
  },
  // 自定义渠道没有表情回应, ack 由调用方自己处理。
  processingEmoji: '',
} as unknown as ImUiTextPack;
