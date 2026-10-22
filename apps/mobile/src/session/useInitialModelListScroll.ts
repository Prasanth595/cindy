import { useCallback, useEffect, useRef } from "react";
import type { FlatList, LayoutChangeEvent } from "react-native";

/** Reveal once per opening, using measured cells rather than fixed model heights. */
export function useInitialModelListScroll({
  visible,
  active,
  query,
  filter,
  target,
}: {
  visible: boolean;
  active: boolean;
  query: string;
  filter: string;
  target: { key: string; index: number } | null;
}) {
  const listRef = useRef<FlatList>(null);
  const latest = useRef({ visible, active, query, target });
  latest.current = { visible, active, query, target };
  const pending = useRef(false);
  const positioned = useRef<{ key: string; index: number } | null>(null);
  const laidOut = useRef(false);
  const measured = useRef(new Set<string>());
  const frame = useRef<number | null>(null);
  const failed = useRef(false);

  const stopFrame = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const cancel = useCallback(() => {
    pending.current = false;
    positioned.current = null;
    stopFrame();
  }, [stopFrame]);
  const schedule = useCallback(() => {
    if (!pending.current || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const current = latest.current;
      if (
        !pending.current || !current.visible || !current.active || current.query ||
        !current.target || !laidOut.current || !listRef.current
      ) return;
      failed.current = false;
      listRef.current.scrollToIndex({
        index: current.target.index,
        viewPosition: 0.35,
        animated: false,
      });
      // FlatList can accept an approximate index before the target is mounted.
      // Finish only after that cell's layout; subsequent updates preserve browsing.
      if (!failed.current && measured.current.has(current.target.key)) {
        pending.current = false;
        positioned.current = current.target;
      }
    });
  }, []);

  useEffect(() => {
    pending.current = visible;
    if (visible) schedule();
    else stopFrame();
    return cancel;
  }, [visible, schedule, stopFrame, cancel]);
  useEffect(() => {
    // Opening may briefly retain the previous query/options until the parent
    // resets them. Only explicit user actions cancel the opening request.
    // Remote favorites load separately and can insert rows above our target.
    // Keep that same opening anchor until the user takes control; do not follow
    // a different selected model after the initial reveal.
    if (
      positioned.current && target?.key === positioned.current.key &&
      target.index !== positioned.current.index
    ) pending.current = true;
    else if (positioned.current && target?.key !== positioned.current.key)
      positioned.current = null;
    schedule();
  }, [active, query, filter, target?.key, target?.index, schedule]);

  return {
    listRef,
    cancel,
    onLayout: (event: LayoutChangeEvent) => {
      laidOut.current = event.nativeEvent.layout.height > 0;
      schedule();
    },
    onItemLayout: (key: string) => {
      measured.current.add(key);
      schedule();
    },
    onContentSizeChange: schedule,
    onViewableItemsChanged: schedule,
    onScrollToIndexFailed: ({ index, averageItemLength }: { index: number; averageItemLength: number }) => {
      failed.current = true;
      if (!pending.current || index !== latest.current.target?.index || averageItemLength <= 0) return;
      // Render the distant window, then retry after its native layout. No timer
      // races with a drag, search, dismissal or a secondary settings page.
      listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
    },
  };
}
