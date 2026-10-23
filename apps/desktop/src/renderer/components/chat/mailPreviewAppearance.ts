const authoredStyleAttribute = 'data-cindy-mail-authored-style';

/** Restore both live nodes and browser-created clones from the same preview
 * metadata. The mail sanitizer strips this attribute from incoming/outgoing HTML. */
export function restoreMailPreviewPaint(root: Element): void {
  for (const el of [root, ...root.querySelectorAll(`[${authoredStyleAttribute}]`)]) {
    const encoded = el.getAttribute(authoredStyleAttribute);
    if (encoded === null) continue;
    el.removeAttribute(authoredStyleAttribute);
    try {
      const style: unknown = JSON.parse(encoded);
      if (style === null) el.removeAttribute('style');
      else if (typeof style === 'string') el.setAttribute('style', style);
    } catch { /* Invalid transient metadata is never interpreted as a style. */ }
  }
}

/** Preview-only paint. Source HTML, CID images and editing spans stay intact. */
export function followMailPreviewTheme(doc: Document, host: Document): () => void {
  const restore = () => restoreMailPreviewPaint(doc.documentElement);
  let previous = '';
  const paint = () => {
    const root = host.documentElement;
    const theme = host.defaultView!.getComputedStyle(root);
    const dark = root.classList.contains('dark');
    const surface = theme.getPropertyValue('--surface').trim();
    const text = theme.getPropertyValue('--text-primary').trim();
    const border = theme.getPropertyValue('--border-default').trim();
    const key = JSON.stringify([dark, surface, text, border]);
    if (key === previous) return;
    previous = key;
    restore();
    // Light mode preserves authored paper, colors and decoration. Recoloring
    // white backgrounds there exposes seams around images and signature tables.
    if (!dark || !surface || !text || !doc.defaultView) return;

    // Read all authored colors before changing inheritance. Keep the original
    // inline attributes so theme changes and cleanup are lossless, even after typing.
    const nodes = Array.from(doc.querySelectorAll<HTMLElement>('html, body, body *'))
      .filter(el => el.tagName !== 'IMG');
    const authored = nodes.map(el => {
      const css = doc.defaultView!.getComputedStyle(el);
      return { el, style: el.getAttribute('style'), color: css.color, background: css.backgroundColor,
        image: css.backgroundImage, border: css.borderTopColor };
    });
    const colorInfo = (color: string) => {
      const rgb = color.match(/^rgba?\(([^)]+)\)/)?.[1].split(/[, /]+/).map(Number);
      if (!rgb || rgb.length < 3 || rgb[3] === 0) return null;
      return {
        brightness: (rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255,
        neutral: Math.max(...rgb.slice(0, 3)) - Math.min(...rgb.slice(0, 3)) <= 16,
      };
    };
    for (const entry of authored) {
      const { el } = entry;
      // Native Enter/split/undo can clone these nodes. Carry the authored
      // style with the clone so neither saving nor cleanup relies on identity.
      el.setAttribute(authoredStyleAttribute, JSON.stringify(entry.style));
      const set = (name: string, value: string) => el.style.setProperty(name, value, 'important');
      const background = colorInfo(entry.background), foreground = colorInfo(entry.color);
      if (background && background.brightness > 0.25) {
        // Ordinary white/gray mail should share the reading canvas. Mixing
        // white into dark surfaces creates a conspicuous gray rectangle.
        set('background-color', background.neutral ? surface : `color-mix(in srgb, ${surface} 92%, ${entry.background})`);
      }
      if (foreground && foreground.brightness < 0.72) {
        set('color', foreground.neutral ? text : `color-mix(in srgb, ${text} 80%, ${entry.color})`);
      }
      if (border && colorInfo(entry.border)) set('border-color', `color-mix(in srgb, ${border} 75%, ${entry.border})`);
      // CSS backgrounds are decoration (remote CSS URLs are already removed by
      // the sanitizer). Photos remain untouched; no inversion filter is used.
      if (entry.image && entry.image !== 'none') set('background-image', 'none');
    }
    doc.documentElement.style.setProperty('color-scheme', 'dark', 'important');
    doc.documentElement.style.setProperty('background-color', surface, 'important');
  };
  paint();
  const observer = new MutationObserver(paint);
  observer.observe(host.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] });
  return () => { observer.disconnect(); restore(); };
}
