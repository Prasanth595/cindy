/**
 * 新建页当前未发送任务的 id(无依赖的小登记表)。侧栏分组等纯函数据此把它当成普通任务
 * 放进所选项目，而不是按「从未发送」归到未分类。生命周期由 provisionalDraftTask.ts 管理。
 */

let currentId: string | null = null;
const listeners = new Set<() => void>();

export function getProvisionalDraftTaskId(): string | null {
  return currentId;
}

export function setProvisionalDraftTaskId(id: string | null): void {
  if (currentId === id) return;
  currentId = id;
  for (const listener of listeners) listener();
}

export function subscribeProvisionalDraftTaskId(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
