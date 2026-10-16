import { useCallback, useMemo, useRef, type Ref } from 'react';
import { Animated, type ScrollView, type ScrollViewProps, type View } from 'react-native';
import { measure, runOnJS, useAnimatedRef, useSharedValue, type AnimatedRef, type SharedValue } from 'react-native-reanimated';
import { Gesture, GestureDetector } from '@/platform/gestureHandler';

/**
 * 「从聊天记录拖进输入框」：手指在聊天记录里拖动时照常滚动；同一次拖动里手指往下
 * 越过展开输入框的顶边后，这次拖动交给输入框，等同于按住顶边往下拖。
 *
 * 列表与输入框分属不同组件，只经这座桥交换 UI 线程状态：
 * - 输入框写 armed（展开卡片态才可接手）并把顶边热区挂到 grabberRef；
 * - 列表侧追踪手指，接手后持续写 event，输入框用 useAnimatedReaction 驱动同一套调高逻辑。
 * event 每次都带完整位置（而非 begin / move / end 增量），同一帧内被合并也不会丢步。
 */
export interface ComposerPullEvent {
  /** 本次接手的编号；0 表示还没有发生过接手。 */
  id: number;
  /** 手指仍按着。false 即本次接手结束。 */
  active: boolean;
  /** 接手时输入框顶边的屏幕 y：调高位移从这里起算。 */
  startY: number;
  /** 手指当前屏幕 y。 */
  y: number;
  /** 正常抬手为 true；被系统取消为 false（恢复原高度）。 */
  successful: boolean;
}

export interface ComposerPullThroughBridge {
  armed: SharedValue<boolean>;
  event: SharedValue<ComposerPullEvent>;
  grabberRef: AnimatedRef<View>;
}

export function useComposerPullThroughBridge(): ComposerPullThroughBridge {
  const armed = useSharedValue(false);
  const event = useSharedValue<ComposerPullEvent>({ id: 0, active: false, startY: 0, y: 0, successful: false });
  const grabberRef = useAnimatedRef<View>();
  return useMemo(() => ({ armed, event, grabberRef }), [armed, event, grabberRef]);
}

/** 手指往下移动并到达（或越过）输入框顶边时接手。 */
export function shouldHandOffToComposer(input: { y: number; previousY: number; composerTop: number }): boolean {
  'worklet';
  return input.y > input.previousY && input.y >= input.composerTop;
}

/**
 * 接手后的调高位移：只认往下。手指推回去时输入框最多恢复到接手前的高度，
 * 不会被这次拖动撑得比原来更大。
 */
export function composerPullTranslation(input: { y: number; startY: number }): number {
  'worklet';
  return Math.max(0, input.y - input.startY);
}

const PHASE_IDLE = 0;
const PHASE_TRACKING = 1;
const PHASE_HANDED_OFF = 2;

type PullThroughScrollViewProps = ScrollViewProps & {
  bridge: ComposerPullThroughBridge;
  ref?: Ref<ScrollView>;
};

/**
 * 聊天记录列表的滚动容器（LegendList renderScrollComponent）。
 *
 * 原生滚动照常进行：Native 手势只让列表加入 RNGH 编排；追踪手势 manualActivation 永不激活，
 * 只读触摸位置，不认领手势、不取消行内点击。接手时把列表滚动关掉（输入框接管这次拖动，
 * 两边不同时动）；抬手后恢复。追踪不依赖 Native 手势存活——关掉滚动会让原生滚动手势取消。
 */
export function ComposerPullThroughScrollView({ bridge, ref, ...props }: PullThroughScrollViewProps) {
  const scrollRef = useRef<ScrollView | null>(null);
  const scrollEnabledRef = useRef(props.scrollEnabled !== false);
  scrollEnabledRef.current = props.scrollEnabled !== false;
  const setRef = useCallback((node: ScrollView | null) => {
    scrollRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) (ref as { current: ScrollView | null }).current = node;
  }, [ref]);
  const setFrozen = useCallback((frozen: boolean) => {
    scrollRef.current?.setNativeProps({ scrollEnabled: frozen ? false : scrollEnabledRef.current });
  }, []);

  const phase = useSharedValue(PHASE_IDLE);
  const previousY = useSharedValue(0);
  const composerTop = useSharedValue(0);
  const gesture = useMemo(() => {
    const { armed, event, grabberRef } = bridge;
    const end = (y: number, successful: boolean) => {
      'worklet';
      if (phase.value === PHASE_HANDED_OFF) {
        const current = event.value;
        event.value = { id: current.id, active: false, startY: current.startY, y: Number.isFinite(y) ? y : current.y, successful };
        runOnJS(setFrozen)(false);
      }
      phase.value = PHASE_IDLE;
    };
    const tracker = Gesture.Pan()
      .manualActivation(true)
      .onTouchesDown((touches) => {
        'worklet';
        phase.value = PHASE_IDLE;
        if (touches.numberOfTouches !== 1 || !armed.value) return;
        const frame = measure(grabberRef);
        const y = touches.allTouches[0]?.absoluteY;
        // 只从输入框上方的聊天记录起手；按在输入框上的触摸本就归输入框。
        if (!frame || y === undefined || y >= frame.pageY) return;
        composerTop.value = frame.pageY;
        previousY.value = y;
        phase.value = PHASE_TRACKING;
      })
      .onTouchesMove((touches) => {
        'worklet';
        if (phase.value === PHASE_IDLE) return;
        const y = touches.allTouches[0]?.absoluteY;
        if (touches.numberOfTouches !== 1 || y === undefined) {
          end(NaN, false);
          return;
        }
        if (phase.value === PHASE_TRACKING) {
          if (armed.value && shouldHandOffToComposer({ y, previousY: previousY.value, composerTop: composerTop.value })) {
            phase.value = PHASE_HANDED_OFF;
            event.value = { id: event.value.id + 1, active: true, startY: composerTop.value, y, successful: false };
            runOnJS(setFrozen)(true);
          }
          previousY.value = y;
          return;
        }
        const current = event.value;
        event.value = { id: current.id, active: true, startY: current.startY, y, successful: false };
      })
      .onTouchesUp((touches) => {
        'worklet';
        end(touches.changedTouches[0]?.absoluteY ?? NaN, true);
      })
      .onTouchesCancelled(() => {
        'worklet';
        end(NaN, false);
      })
      .onFinalize(() => {
        'worklet';
        // 被其它手势挤掉时不会再收到抬手：按取消收尾，输入框回到原高度。
        end(NaN, false);
      });
    return Gesture.Simultaneous(Gesture.Native(), tracker);
  }, [bridge, composerTop, phase, previousY, setFrozen]);

  return (
    <GestureDetector gesture={gesture}>
      <Animated.ScrollView {...props} ref={setRef} />
    </GestureDetector>
  );
}
