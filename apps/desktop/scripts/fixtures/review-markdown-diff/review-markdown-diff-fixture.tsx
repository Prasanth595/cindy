import { mountPage, subscription } from '../../ui-page/harness';
import { MarkdownDiffPreview } from '../../../src/renderer/features/right-sidebar/plugins/review/DiffViewer/MarkdownDiffPreview';
import type { FileDiff, ReviewMarkdownPreviewData } from '../../../src/renderer/lib/gitReview.types';

// 覆盖本 PR 修的四类边界：普通词句、有序/无序任务项、表格、公式与字符实体。
const BEFORE = [
  '# 需求说明',
  '',
  '本方案用于校准 `review` 插件的富文本预览。',
  '',
  '## 待办',
  '',
  '1. [x] 收集基线数据',
  '2. [ ] 与旧版本对比',
  '- [ ] 通知负责人',
  '',
  '| 指标 | 阈值 |',
  '| --- | --- |',
  '| 延迟 | 120ms |',
  '| 吞吐 | 900 op/s |',
  '',
  '成本上限 $C_{max} = 2n$，超过即告警；实体如 &copy; 与 &amp; 需原样保留。',
].join('\n');

const AFTER = [
  '# 需求说明（修订版）',
  '',
  '本方案用于校准 `review` 插件的富文本预览与导出。',
  '',
  '## 待办',
  '',
  '1. [x] 收集基线数据',
  '2. [x] 与旧版本对比',
  '- [ ] 通知各负责人',
  '',
  '| 指标 | 阈值 |',
  '| --- | --- |',
  '| 延迟 | 150ms |',
  '| 吞吐 | 1200 op/s |',
  '| 错误率 | <0.1% |',
  '',
  '成本上限 $C_{max} = 3n$，超过即告警；实体如 &copy; 与 &reg; 需原样保留。',
].join('\n');

const diff: FileDiff = {
  id: 'unstaged:docs/需求说明.md',
  source: 'unstaged',
  path: 'docs/需求说明.md',
  oldPath: null,
  status: 'modified',
  kind: 'text',
  size: AFTER.length,
  additions: 6,
  deletions: 4,
  isBinary: false,
  isSubmodule: false,
  isTooLarge: false,
  mode: { old: null, new: null },
  index: { oldOid: null, newOid: null },
  rawHeader: '',
  rawPatch: '',
  hunks: [],
  error: null,
};

const data: ReviewMarkdownPreviewData & { content: string; beforeContent: string } = {
  diffId: diff.id,
  content: AFTER,
  beforeContent: BEFORE,
  size: AFTER.length,
  baseDir: '/repo/docs',
  maxBytes: 1024 * 1024,
  reason: null,
  error: null,
};

function Fixture() {
  return (
    <main className="mx-auto w-full max-w-[860px] p-4">
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] p-4">
        <MarkdownDiffPreview
          diff={diff}
          loadMarkdownPreview={async () => data}
          fallback={<span>fallback</span>}
        />
      </div>
    </main>
  );
}

void mountPage({
  host: { maker: {
    onProvidersChanged: subscription('providersChanged'),
  } },
  render: () => <Fixture />,
});
