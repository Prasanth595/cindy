/**
 * crossAgentConvertService — renderer 侧 IPC 薄层。
 *
 * 仅命令转发，不持有状态。
 */

export const crossAgentConvertService = {
  listSuppressedWorkspaces(): Promise<string[]> {
    return window.electronAPI.maker.crossAgent.listSuppressedWorkspaces();
  },
  suppressAgentsMdPrompt(workingDir: string): Promise<string[]> {
    return window.electronAPI.maker.crossAgent.suppressAgentsMdPrompt(workingDir);
  },
  restoreAgentsMdPrompt(workingDir: string): Promise<string[]> {
    return window.electronAPI.maker.crossAgent.restoreAgentsMdPrompt(workingDir);
  },
  detect(workingDir: string, agentKind: 'claude-code' | 'codex', respectPromptPreference = true): Promise<{ items: CrossAgentMigrationItem[] }> {
    return window.electronAPI.maker.crossAgent.detect(workingDir, agentKind, respectPromptPreference);
  },
  convert(items: CrossAgentMigrationItem[]): Promise<{
    total: number;
    successCount: number;
    skippedCount: number;
    failedCount: number;
  }> {
    return window.electronAPI.maker.crossAgent.convert(items);
  },
  /** 订阅每步进度事件，返回 unsubscribe。 */
  onStep(cb: (ev: CrossAgentStepEvent) => void): () => void {
    return window.electronAPI.maker.crossAgent.onStep(cb);
  },
};
