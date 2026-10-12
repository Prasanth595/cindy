import { useLayoutEffect } from 'react';

const sidebarSelector = '.wallpaper-navigation-surface';
const properties = ['left', 'top', 'width', 'height'] as const;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Only task navigation is excluded; chat and tool panes share the remaining canvas. */
export function getWallpaperContentBounds(
  viewport: { width: number; height: number },
  sidebars: readonly Rect[],
) {
  let left = 0;
  let right = viewport.width;
  const top = 0;
  const bottom = viewport.height;
  for (const sidebar of sidebars) {
    if (sidebar.bottom <= top || sidebar.top >= bottom || sidebar.right <= sidebar.left) continue;
    if (sidebar.left <= left && sidebar.right > left) left = Math.min(right, sidebar.right);
    else if (sidebar.right >= right && sidebar.left < right) right = Math.max(left, sidebar.left);
  }
  return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** DOM geometry only: leave the layout tree and the single media element untouched. */
export function useWallpaperContentBounds(enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    let frame = 0;
    let observed: Element[] = [];
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    function update() {
      frame = 0;
      const sidebars = Array.from(document.querySelectorAll(sidebarSelector));
      const targets = sidebars;
      if (targets.length !== observed.length || targets.some((node, i) => node !== observed[i])) {
        resize?.disconnect();
        targets.forEach((node) => resize?.observe(node));
        observed = targets;
      }
      const bounds = getWallpaperContentBounds(
        { width: window.innerWidth, height: window.innerHeight },
        sidebars.map((node) => node.getBoundingClientRect()),
      );
      for (const property of properties) {
        const value = `${bounds[property]}px`;
        const name = `--app-wallpaper-content-${property}`;
        if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
      }
      // A saved exclusion preference must not introduce letterboxing on pages
      // without navigation (settings, detached tools), or when it is fully hidden.
      if (bounds.width < window.innerWidth) root.dataset.wallpaperFitContent = 'true';
      else delete root.dataset.wallpaperFitContent;
      // Transforms change the visible edge without resizing the element. Track
      // only animations on navigation hosts (not animated message descendants).
      // Query live animations so cancellation, replacement and removal cannot
      // leave an event counter keeping this loop alive indefinitely.
      if (
        sidebars.some((node) =>
          node
            .getAnimations?.()
            .some((animation) => animation.playState === 'running' || animation.pending),
        )
      )
        schedule();
    }
    const mutations = new MutationObserver((records) => {
      if (
        records.some((record) => {
          const target = record.target;
          if (!(target instanceof Element)) return false;
          if (target.matches(sidebarSelector) || observed.some((node) => target.contains(node)))
            return true;
          return (
            record.type === 'childList' &&
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element &&
                (node.matches(sidebarSelector) || node.querySelector(sidebarSelector)),
            )
          );
        })
      )
        schedule();
    });
    // Ignore ordinary streaming-message mutations; only layout ancestors/hosts matter.
    mutations.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-sidebar-peek-drawer'],
    });
    // Transform-only peek animations do not trigger ResizeObserver.
    const onMotion = (event: Event) => {
      if (event.target instanceof Element && event.target.matches(sidebarSelector)) schedule();
    };
    const motionEvents = [
      'animationstart',
      'animationend',
      'animationcancel',
      'transitionrun',
      'transitionend',
      'transitioncancel',
    ] as const;
    motionEvents.forEach((type) => document.body.addEventListener(type, onMotion));
    window.addEventListener('resize', schedule);
    update();
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      mutations.disconnect();
      motionEvents.forEach((type) => document.body.removeEventListener(type, onMotion));
      window.removeEventListener('resize', schedule);
      delete root.dataset.wallpaperFitContent;
      properties.forEach((property) =>
        root.style.removeProperty(`--app-wallpaper-content-${property}`),
      );
    };
  }, [enabled]);
}
