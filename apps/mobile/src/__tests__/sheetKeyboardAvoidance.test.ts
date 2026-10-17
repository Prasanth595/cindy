import { describe, expect, it } from 'vitest';
import { computeAndroidSheetKeyboardLift } from '@/session/sheetKeyboardAvoidance';

const base = {
  imeHeight: 300,
  systemBarBottom: 0,
  windowVisibleBottom: 844,
  screenHeight: 844,
  contentHeight: 844,
  baselineContentHeight: 844,
};

describe('computeAndroidSheetKeyboardLift', () => {
  it('asks for the keyboard height when the window did not shrink (edge-to-edge)', () => {
    // screenY 退化为窗口底边:系统没让出高度,浮窗整体让位。
    expect(computeAndroidSheetKeyboardLift(base)).toBe(300);
  });

  it('re-adds the system bar that RN subtracted from the IME height', () => {
    expect(computeAndroidSheetKeyboardLift({
      ...base,
      systemBarBottom: 24,
      windowVisibleBottom: 820,
    })).toBe(300);
  });

  it('does not double-avoid when adjustResize already shrank the window', () => {
    // 缩窗:可见区底边 = 键盘顶边,内容区也真的矮了 324(300 + 导航栏)。
    expect(computeAndroidSheetKeyboardLift({
      ...base,
      systemBarBottom: 24,
      windowVisibleBottom: 520,
      contentHeight: 520,
    })).toBe(0);
  });

  it('keeps using the measured shrink when the keyboard event reports a stale edge', () => {
    // 事件来自另一个 window root(screenY = 窗口底边),但浮窗自己确实缩了窗。
    expect(computeAndroidSheetKeyboardLift({
      ...base,
      systemBarBottom: 24,
      contentHeight: 520,
    })).toBe(0);
  });

  it('does not over-lift a sheet opened while the keyboard is already up on a shrinking window', () => {
    expect(computeAndroidSheetKeyboardLift({
      ...base,
      systemBarBottom: 24,
      windowVisibleBottom: 520,
      contentHeight: 520,
      baselineContentHeight: 0,
    })).toBe(0);
  });

  it('only lifts the part the system did not reserve', () => {
    expect(computeAndroidSheetKeyboardLift({ ...base, windowVisibleBottom: 744 })).toBe(200);
  });

  it('stays at zero while the keyboard is hidden or reports no height', () => {
    expect(computeAndroidSheetKeyboardLift({ ...base, imeHeight: 0 })).toBe(0);
    expect(computeAndroidSheetKeyboardLift({ ...base, imeHeight: -12, systemBarBottom: -4 })).toBe(0);
  });

  it('ignores sub-pixel resize noise instead of flickering the lift', () => {
    // 不缩窗时 screenY 与内容区高度都可能带 1~2px 抖动,不能因此把让位打成 0。
    expect(computeAndroidSheetKeyboardLift({ ...base, windowVisibleBottom: 836 })).toBe(300);
    expect(computeAndroidSheetKeyboardLift({ ...base, baselineContentHeight: 852, contentHeight: 844 })).toBe(300);
  });

  it('treats unknown geometry as «the system reserved nothing»', () => {
    expect(computeAndroidSheetKeyboardLift({ ...base, screenHeight: Number.NaN })).toBe(300);
    expect(computeAndroidSheetKeyboardLift({ ...base, imeHeight: Number.NaN })).toBe(0);
  });

  it('never returns a negative lift and rounds fractional geometry', () => {
    // 可见区底边已经越过键盘顶(事件乱序/重复上报)时按「系统已让出」处理,不再叠加。
    expect(computeAndroidSheetKeyboardLift({ ...base, windowVisibleBottom: 0 })).toBe(0);
    expect(computeAndroidSheetKeyboardLift({ ...base, imeHeight: 300.4 })).toBe(300);
    expect(computeAndroidSheetKeyboardLift({ ...base, imeHeight: 300.5 })).toBe(301);
  });
});
