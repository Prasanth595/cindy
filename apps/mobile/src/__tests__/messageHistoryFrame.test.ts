import { describe, expect, it } from 'vitest';
import { stabilizeMessageHistoryFrame, type MessageHistoryFrame } from '@/session/messageHistoryFrame';

const measured = (patch: Partial<MessageHistoryFrame> = {}): MessageHistoryFrame => ({
  left: 0, top: 48, width: 1280, height: 752, ...patch,
});

describe('stabilizeMessageHistoryFrame', () => {
  it('pins a tablet detail pane when measureInWindow reports the whole window', () => {
    // Dragging on Android can make the anchor report the window box. The task
    // column then gets message rows painted over it.
    expect(stabilizeMessageHistoryFrame(measured(), { x: 320, width: 960 }, 0)).toEqual({
      left: 320, top: 48, width: 960, height: 752,
    });
  });

  it('keeps a correct phone measurement when the pane already starts at the window edge', () => {
    const phone = measured({ left: 0, width: 390, height: 800 });
    expect(stabilizeMessageHistoryFrame(phone, { x: 0, width: 390 }, 0)).toEqual(phone);
  });

  it('subtracts the history host origin so a window-level pane x stays host-relative', () => {
    expect(stabilizeMessageHistoryFrame(measured({ left: 300, width: 900 }), { x: 368, width: 912 }, 48).left)
      .toBe(320);
  });

  it('does not invent a pane when the caller has no horizontal box yet', () => {
    const frame = measured();
    expect(stabilizeMessageHistoryFrame(frame, null, 0)).toBe(frame);
    expect(stabilizeMessageHistoryFrame(frame, { x: Number.NaN, width: 960 }, 0)).toBe(frame);
    expect(stabilizeMessageHistoryFrame(frame, { x: 320, width: 0 }, 0)).toBe(frame);
  });
});
