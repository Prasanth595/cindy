import { describe, expect, it } from 'vitest';
import { encodeInvokeResultTransfer, InvokeResultCache } from '@cindy/device-link';
import { desktopTransferCodec } from '../transferCodec';

describe('desktop device-link transfer codec', () => {
  it('round-trips a large result between a desktop host and a desktop controller', () => {
    const result = Array.from({ length: 300 }, (_, i) => ({ id: `s-${i}`, title: '远程任务 ✓' }));
    const controller = new InvokeResultCache(desktopTransferCodec);
    const request = controller.prepare('desktop-b', { channel: 'local-db:sessions:list', args: [] });
    const wire = encodeInvokeResultTransfer(request.payload.transfer!, { ok: true, result }, desktopTransferCodec);
    expect(wire.ok && wire.transfer?.gzipBase64).toEqual(expect.any(String));
    expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify(result).length / 4);
    expect(request.decode(wire)).toEqual({ ok: true, result });
  });

  it('produces a stable content tag', () => {
    expect(desktopTransferCodec.contentTag!('abc')).toBe(desktopTransferCodec.contentTag!('abc'));
    expect(desktopTransferCodec.contentTag!('abc')).not.toBe(desktopTransferCodec.contentTag!('abd'));
  });

  it('stops decompressing once the output limit is exceeded', () => {
    const bomb = desktopTransferCodec.gzipBase64!('a'.repeat(1_000_000));
    expect(desktopTransferCodec.gunzipBase64!(bomb, 1_000_000)).toHaveLength(1_000_000);
    expect(() => desktopTransferCodec.gunzipBase64!(bomb, 100_000)).toThrow();
    // Multi-byte text is measured in JS string length, not UTF-8 bytes.
    const cjk = desktopTransferCodec.gzipBase64!('弱'.repeat(1_000));
    expect(desktopTransferCodec.gunzipBase64!(cjk, 1_000)).toHaveLength(1_000);
    expect(() => desktopTransferCodec.gunzipBase64!(cjk, 999)).toThrow();
  });
});
