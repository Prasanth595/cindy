export default {
  name: 'review-markdown-diff',
  entry: './review-markdown-diff-fixture.tsx',
  viewport: { width: 900, height: 900 },
  real: 'MarkdownDiffPreview, buildMarkdownPreviewPlan, MarkdownRenderer review annotations, themes and translations',
  notCovered: 'Real git transport, review session wiring and native mobile',
  cases: {
    default: { about: 'Word 修订式富文本预览：词句/任务项/表格/公式/实体的改动标记' },
  },
  async check(page, ui) {
    await page.locator('[data-review-markdown-change="revision"]').first().waitFor();
    const del = await page.locator('del, [data-review-del]').count();
    const ins = await page.locator('ins, [data-review-ins]').count();
    if (del === 0 || ins === 0) throw new Error(`revision marks missing (del=${del}, ins=${ins})`);
    await ui.capture('revision-view');
  },
};
