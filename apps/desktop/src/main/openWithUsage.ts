import { atomicWriteFileSync, readAtomicFileSync } from './utils/atomicWriteFile.js';

export interface OpenWithUsage {
  getLastUsed(appPath: string): number;
  recordUsed(appPath: string, timestamp: number): void;
}

/** 仅存本子菜单打开应用的时间，不存文件路径、文件内容或默认打开方式。 */
export function createOpenWithUsageStore(filePath: string, onReadError: () => void): OpenWithUsage {
  function read(): Record<string, number> {
    const contents = readAtomicFileSync(filePath);
    if (contents === null) return Object.create(null) as Record<string, number>;
    const parsed = JSON.parse(contents) as { version?: unknown; lastUsed?: unknown };
    if (
      !parsed ||
      parsed.version !== 1 ||
      !parsed.lastUsed ||
      typeof parsed.lastUsed !== 'object' ||
      Array.isArray(parsed.lastUsed)
    ) {
      throw new Error('Invalid open-with usage data');
    }
    const result: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const [key, value] of Object.entries(parsed.lastUsed)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) result[key] = value;
    }
    return result;
  }
  return {
    getLastUsed(appPath) {
      try {
        return read()[appPath] ?? 0;
      } catch {
        onReadError();
        return 0;
      }
    },
    recordUsed(appPath, timestamp) {
      // 读取失败时不把已有文件覆盖成空快照。记录失败由调用者隔离，不阻止打开。
      const lastUsed = read();
      lastUsed[appPath] = Math.max(lastUsed[appPath] ?? 0, timestamp);
      atomicWriteFileSync(filePath, JSON.stringify({ version: 1, lastUsed }));
    },
  };
}
