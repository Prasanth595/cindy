/**
 * 「选择文字」面板里的正文（docs/product-rules/cindy-bots-runtime.md「私聊引用回复」手机端）：
 * 去掉 Markdown 记号，只留读者看到的文字；代码块与行内代码保持原文，复制出来的代码与气泡里一致。
 */
const FENCE_LINE = /^\s*(```|~~~)/;

function plainProse(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2');
}

function plainLine(line: string): string {
  const prose = line.replace(/^#{1,6}\s+/, '').replace(/^(\s*)[-*+]\s+/, '$1• ');
  // Odd parts are inline code: keep their content as is, only drop the backticks.
  return prose.split(/(`[^`\n]+`)/).map((part, index) => (index % 2 ? part.slice(1, -1) : plainProse(part))).join('');
}

export function selectableMessageText(markdown: string): string {
  let fence: string | null = null;
  const lines: string[] = [];
  for (const line of markdown.split('\n')) {
    const marker = FENCE_LINE.exec(line)?.[1];
    if (marker && (!fence || marker === fence)) {
      fence = fence ? null : marker;
      continue;
    }
    lines.push(fence ? line : plainLine(line));
  }
  return lines.join('\n');
}
