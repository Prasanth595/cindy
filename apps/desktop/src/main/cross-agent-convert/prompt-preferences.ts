import fs from 'node:fs/promises';
import path from 'node:path';

import { createOverrideSettingsFile } from '../maker-host/override-settings-file.js';
import { createLogger } from '../logger.js';

interface PromptPreferences {
  /** Only AGENTS.md → CLAUDE.md. Other directions and migration kinds are independent. */
  suppressedWorkspaces: string[];
}

/** Profile-local UI overrides; never write into the user's workspace. */
export function createMigrationPromptPreferences(filePath: () => string) {
  const store = createOverrideSettingsFile<PromptPreferences>({
    filePath,
    defaults: { suppressedWorkspaces: [] },
    normalize(raw) {
      const value = (raw as Partial<PromptPreferences>)?.suppressedWorkspaces;
      return {
        suppressedWorkspaces: Array.isArray(value)
          ? [
              ...new Set(
                value.filter(
                  (entry): entry is string => typeof entry === 'string' && path.isAbsolute(entry),
                ),
              ),
            ]
          : [],
      };
    },
    log: createLogger('migration-prompt-preferences'),
    label: 'migration-prompt',
    maxBytes: 1024 * 1024,
    preserveUnreadableFile: true,
    logLoadedValue: false,
    logReadErrorDetails: false,
  });

  const list = (): string[] => {
    store.invalidateIfChanged();
    return [...store.read().suppressedWorkspaces];
  };
  const identity = async (workingDir: string): Promise<string> => {
    // A removed directory must remain restorable. Realpath joins symlink aliases
    // while each physical worktree remains its own workspace.
    const resolved = await fs.realpath(workingDir).catch(() => path.resolve(workingDir));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return {
    list,
    async isSuppressed(workingDir: string): Promise<boolean> {
      const key = await identity(workingDir);
      return list().includes(key);
    },
    async setSuppressed(workingDir: string, suppressed: boolean): Promise<string[]> {
      // A listed path may since have been replaced with a symlink to a different
      // workspace. Restore the selected saved entry, not the new symlink target.
      const key =
        !suppressed && list().includes(workingDir) ? workingDir : await identity(workingDir);
      const result = await store.updateAtomic(({ value }) => ({
        suppressedWorkspaces: suppressed
          ? [...new Set([...value.suppressedWorkspaces, key])]
          : value.suppressedWorkspaces.filter((entry) => entry !== key),
      }));
      return result.suppressedWorkspaces;
    },
  };
}
