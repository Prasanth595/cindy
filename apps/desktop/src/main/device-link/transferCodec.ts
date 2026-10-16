import { createHash } from 'node:crypto';
import { constants, gunzipSync, gzipSync } from 'node:zlib';
import type { DeviceLinkTransferCodec } from '@cindy/device-link';

/**
 * Desktop 既是被控端也是控制端（桌面远控桌面），两个方向共用一份编码器。
 * 压缩级别取速度优先：大结果在主进程同步压缩，几百 KB 的会话列表约几毫秒。
 */
export const desktopTransferCodec: DeviceLinkTransferCodec = {
  gzipBase64: (text) => gzipSync(Buffer.from(text, 'utf8'), { level: constants.Z_BEST_SPEED + 3 }).toString('base64'),
  gunzipBase64: (base64, maxChars) => {
    // One UTF-16 unit never needs more than 3 UTF-8 bytes; zlib stops at the cap.
    const text = gunzipSync(Buffer.from(base64, 'base64'), { maxOutputLength: maxChars * 3 }).toString('utf8');
    if (text.length > maxChars) throw new RangeError('decompressed invoke result exceeds limit');
    return text;
  },
  contentTag: (text) => createHash('sha256').update(text).digest('base64url'),
};
