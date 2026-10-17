export interface MessageHistoryFrame {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Horizontal box of the resident message layer.
 *
 * The detail pane from `sessionPaneLayout` is the layout source of truth: the
 * measuring anchor fills that pane. `pane.x` and `measureInWindow` are both
 * window coordinates, and the history host is the full-window provider, so
 * `pane.x - hostX` is the anchor's horizontal origin.
 *
 * Android can report the whole window from `measureInWindow` while a finger is
 * dragging the list. Publishing that box leaves message rows painted across the
 * task column after the gesture ends. Vertical position still comes from the
 * measurement, because chrome above the list is not part of the pane width.
 */
export function stabilizeMessageHistoryFrame(
  measured: MessageHistoryFrame,
  pane: { x: number; width: number } | null,
  hostX: number,
): MessageHistoryFrame {
  if (!pane || !Number.isFinite(pane.x) || !Number.isFinite(pane.width) || pane.width <= 0 || !Number.isFinite(hostX)) {
    return measured;
  }
  return { ...measured, left: pane.x - hostX, width: pane.width };
}
