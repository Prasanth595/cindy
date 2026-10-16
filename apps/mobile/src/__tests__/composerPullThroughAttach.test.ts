import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('react-native', () => ({
  Animated: { ScrollView: {} },
  Platform: { OS: 'android' },
}));
vi.mock('react-native-reanimated', () => ({
  measure: () => null,
  runOnJS: (fn: unknown) => fn,
  useAnimatedReaction: () => undefined,
  useAnimatedRef: () => ({ current: null }),
  useSharedValue: (initial: unknown) => ({ value: initial }),
}));
vi.mock('@/platform/gestureHandler', () => ({
  Gesture: {},
  GestureDetector: () => null,
}));

import { resolvePullThroughAttach } from '@/session/composerPullThrough';

// 回归锁：runOnJS 的返回值若被保存进变量再在 worklet 里调用，会序列化成不可直接
// 调用的 RemoteFunction 代理，UI 线程一调就报 Tried to synchronously call a Remote
// Function（Greptile P1）。必须保持 reaction 内联调用写法。
const composerPullThroughSource = readFileSync(
  resolve(process.cwd(), 'src/session/composerPullThrough.tsx'), 'utf8',
).replace(/\r\n/g, '\n');

expect(composerPullThroughSource).toContain('runOnJS(setAttach)(');
expect(composerPullThroughSource).not.toMatch(/=\s*runOnJS\(setAttach\)/);

describe('composer pull-through gesture attach gate', () => {
  it('android keeps RNGH off the message list while the composer is idle', () => {
    // RNGH 编排器接管触摸流会让 Android selectable 正文一拖就进选区、列表不滚。
    expect(resolvePullThroughAttach({ android: true, armed: false, busy: false })).toBe(false);
  });

  it('android attaches while the composer is expanded', () => {
    expect(resolvePullThroughAttach({ android: true, armed: true, busy: false })).toBe(true);
  });

  it('android stays attached while a handoff is in flight even after collapse', () => {
    // armed 会在拖动收起输入框时翻 false；busy 期间必须保持 enabled，
    // 否则 tracker 的 end() 不跑，被 setFrozen(true) 冻住的滚动无法恢复。
    expect(resolvePullThroughAttach({ android: true, armed: false, busy: true })).toBe(true);
    expect(resolvePullThroughAttach({ android: true, armed: true, busy: true })).toBe(true);
  });

  it('ios keeps the always-attached behavior unchanged', () => {
    expect(resolvePullThroughAttach({ android: false, armed: false, busy: false })).toBe(true);
  });
});
