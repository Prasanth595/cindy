/**
 * main/im/shared/permissionInputSummary.ts
 * ---------------------------------------------------------------------------
 * permission 授权卡的**正文摘要**: 把工具入参翻成用户看得懂的中文键值行。
 *
 * 卡片此前直接把入参 pretty-print 成 JSON 代码块。工具入参是给机器看的 ——
 * 英文 key、嵌套结构、还夹着审批信封自己的 message / toolDescription 全文;
 * 800 字上限一到就从尾部切, 用户看到一屏字段名, 真正要审的「这次到底要动什么」
 * 正好被切掉。
 *
 * 本模块只做纯函数转换, **不引入任何依赖**(可以脱离打包链直接跑): 截断函数由
 * 调用方注入(cardBuilders 传 interactionCardModel.truncateInline), 未知 key
 * 保留原名不猜, 行数与单行长度都有上限。
 */

/** 已知 key → 中文标签。未知 key 原样显示 —— 宁可露出原名, 也不要猜错。 */
const KEY_LABELS: Record<string, string> = {
  method: '操作',
  path: '路径',
  url: '地址',
  uri: '地址',
  command: '命令',
  cmd: '命令',
  script: '脚本',
  query: '查询',
  keyword: '关键词',
  pattern: '匹配',
  content: '内容',
  body: '内容',
  text: '文本',
  message: '内容',
  file_path: '文件',
  filePath: '文件',
  filename: '文件',
  directory: '目录',
  cwd: '目录',
  repo: '仓库',
  owner: '归属',
  branch: '分支',
  container_id: '会话',
  chat_id: '会话',
  open_id: '用户',
  user_id: '用户',
  issue_number: 'issue',
  pr_number: 'PR',
  page_size: '条数',
  limit: '条数',
  per_page: '条数',
  to: '收件人',
  subject: '主题',
};

/** 纯容器 key: 展开子项时只留子标签, 不写成「参数 · 会话」这种两层名。 */
const CONTAINER_KEYS = new Set(['params', 'args', 'options', 'input']);

/** 对「要不要放行」没有信息量的 key, 不上卡。 */
const SKIP_KEYS = new Set([
  'container_id_type',
  'sort_type',
  'sort',
  'direction',
  'display_name',
  'anonymize',
  'toolName',
  'serverName',
  'toolParamsDisplay',
]);

/** 行序: 先「动什么」, 再「范围/条件」。未列出的 key 排在后面, 保持原顺序。 */
const ROW_PRIORITY = [
  'path',
  'method',
  'command',
  'cmd',
  'script',
  'url',
  'query',
  'pattern',
  'keyword',
  'repo',
  'branch',
  'file_path',
  'cwd',
  'container_id',
  'chat_id',
  'to',
  'subject',
  'content',
  'body',
  'text',
];

/** 值单行截断上限: 一行读完, 不折行。 */
export const PERMISSION_ROW_VALUE_MAX = 60;
/** 卡片最多列几行; 多出来的在末行报数, 不静默丢。 */
export const PERMISSION_ROW_MAX = 6;

/** HTTP 动作 → 中文动词。 */
const METHOD_VERBS: Record<string, string> = {
  GET: '读取',
  POST: '发送',
  PUT: '更新',
  PATCH: '更新',
  DELETE: '删除',
};

/** 路径里的资源词 → 中文宾语(只取第一处命中, 命中不了就退回路径本身)。 */
const RESOURCE_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/messages?\b/i, '消息'],
  [/chats?\b/i, '群信息'],
  [/files?\b/i, '文件'],
  [/documents?\b|docs?\b/i, '文档'],
  [/users?\b|members?\b/i, '成员'],
  [/events?\b/i, '日程'],
  [/issues?\b|pulls?\b/i, 'issue / PR'],
  [/tokens?\b/i, '令牌'],
];

export interface PermissionInputSummary {
  /** 副行用: 谁在调用(审批信封里带了 serverName 才给)。 */
  source: string | null;
  /** 标题用的人话动作; 推不出来时为 null, 调用方退回工具名。 */
  action: string | null;
  /** 正文行, 形如 `路径：/open-apis/im/v1/messages`。 */
  rows: string[];
}

type Truncate = (s: string, max: number) => string;

/**
 * Codex MCP 审批信封拆包: `{ serverName, message, toolName, toolParams,
 * toolParamsDisplay }`(同一形状见 main/messagePersistBroadcaster 的
 * redactToolInputForUntrustedBoundary)。浏览器信封同理, 真实参数在 toolParams
 * 这一层下面。非信封入参原样返回。
 */
export function unwrapMcpApprovalEnvelope(input: Record<string, unknown>): Record<string, unknown> {
  const { toolParams } = input;
  if (typeof input.serverName !== 'string' || typeof input.toolName !== 'string') return input;
  if (!toolParams || typeof toolParams !== 'object' || Array.isArray(toolParams)) return input;
  return toolParams as Record<string, unknown>;
}

/** 信封来源行; 不是信封时 null。 */
export function describePermissionSource(input: Record<string, unknown>): string | null {
  const { serverName, toolName } = input;
  if (typeof serverName !== 'string' || typeof toolName !== 'string') return null;
  return `${serverName} · ${toolName}`;
}

function pickResource(path: string): string | null {
  for (const [pattern, word] of RESOURCE_WORDS) {
    if (pattern.test(path)) return word;
  }
  return null;
}

/** 推得出「读取消息」「执行命令」这类短语就给一句, 推不出给 null。 */
function describeAction(params: Record<string, unknown>): string | null {
  const method = typeof params.method === 'string' ? params.method.toUpperCase() : '';
  const path = typeof params.path === 'string' ? params.path : '';
  if (method && path) {
    const verb = METHOD_VERBS[method] ?? method;
    const resource = pickResource(path);
    return resource ? `${verb}${resource}` : `${verb} ${path}`;
  }
  if (typeof params.command === 'string' || typeof params.cmd === 'string') return '执行命令';
  if (typeof params.script === 'string') return '运行脚本';
  return null;
}

function formatValue(value: unknown, truncate: Truncate): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return `[${value.length} 项]`;
  if (typeof value === 'object') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  return truncate(text, PERMISSION_ROW_VALUE_MAX);
}

/**
 * 入参 → 卡片正文行。
 *
 * 对象值只展开**一层**(再深就成 JSON 了); 标量原样; 数组只报条数。每行
 * `标签：值`, 标签取中文映射, 未知 key 用原名。
 */
function collectRows(params: Record<string, unknown>, truncate: Truncate): string[] {
  const rows: Array<{ key: string; text: string }> = [];
  const push = (key: string, label: string, value: unknown): void => {
    const text = formatValue(value, truncate);
    if (text === null) return;
    rows.push({ key, text: `${label}：${text}` });
  };

  for (const [key, value] of Object.entries(params)) {
    if (SKIP_KEYS.has(key)) continue;
    const label = KEY_LABELS[key] ?? key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (SKIP_KEYS.has(childKey)) continue;
        const childLabel = KEY_LABELS[childKey] ?? childKey;
        const combined = CONTAINER_KEYS.has(key) ? childLabel : `${label} · ${childLabel}`;
        push(`${key}.${childKey}`, combined, childValue);
      }
      continue;
    }
    push(key, label, value);
  }

  const rank = (key: string): number => {
    const index = ROW_PRIORITY.indexOf(key);
    if (index !== -1) return index;
    const head = key.split('.')[0];
    const headIndex = ROW_PRIORITY.indexOf(head);
    return headIndex === -1 ? ROW_PRIORITY.length + 1 : headIndex;
  };

  rows.sort((a, b) => rank(a.key) - rank(b.key));
  if (rows.length <= PERMISSION_ROW_MAX) return rows.map((row) => row.text);
  const kept = rows.slice(0, PERMISSION_ROW_MAX - 1).map((row) => row.text);
  const dropped = rows.length - (PERMISSION_ROW_MAX - 1);
  return [...kept, `…还有 ${dropped} 项参数（可在电脑上查看完整入参）`];
}

export function summarizePermissionInput(
  input: Record<string, unknown>,
  truncate: Truncate,
): PermissionInputSummary {
  const params = unwrapMcpApprovalEnvelope(input);
  return {
    source: describePermissionSource(input),
    action: describeAction(params),
    rows: collectRows(params, truncate),
  };
}
