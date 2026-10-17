/** Native icon calls cannot be cancelled by a JS timeout. Keep timed-out calls
 * in flight, reuse them by path and cap the actual native work, not just waiters. */
export function createOpenWithIconLoader(deps: {
  platform: NodeJS.Platform;
  loadIcon: (appPath: string) => Promise<string | null>;
}): (appPath: string) => Promise<string | null> {
  const cache = new Map<string, string | null>();
  const pending = new Map<string, Promise<string | null>>();
  return async (appPath) => {
    const key = deps.platform === 'win32' ? appPath.toLowerCase() : appPath;
    if (cache.has(key)) return cache.get(key)!;
    let native = pending.get(key);
    if (!native) {
      // Saturation is cosmetic: show a generic icon without queueing more native work.
      if (pending.size >= 4) return null;
      native = Promise.resolve()
        .then(() => deps.loadIcon(appPath))
        .catch(() => null);
      pending.set(key, native);
      void native.then((value) => {
        pending.delete(key);
        if (cache.size >= 256) cache.delete(cache.keys().next().value!);
        cache.set(key, value);
      });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        native,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}
