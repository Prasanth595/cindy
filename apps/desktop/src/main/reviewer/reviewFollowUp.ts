import { t } from '../i18n.js';

const fill = (template: string, values: Record<string, string>): string =>
  Object.entries(values).reduce(
    (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
    template,
  );

const MAX_FOCUS_CHARS = 200;
const MAX_FOLLOW_UP_RESULT_CHARS = 24_000;

/**
 * What the Reviewer task shows as its first message. The model receives the
 * full evidence prompt; people only need to know what was reviewed.
 */
export function buildReviewInputSummary(input: {
  workingDir?: string;
  baseRef?: string;
  hasUncommittedChanges?: boolean;
  additionalWorkingDirs?: readonly string[];
  artifactCount: number;
  focus?: string;
}): string {
  const lines = [t('review.inputSummary.title')];
  if (input.workingDir) {
    const details = [
      input.baseRef ? fill(t('review.inputSummary.baseline'), { base: input.baseRef }) : '',
      input.hasUncommittedChanges ? t('review.inputSummary.uncommitted') : '',
    ].filter(Boolean);
    lines.push(
      [fill(t('review.inputSummary.directory'), { dir: input.workingDir }), ...details].join(' · '),
    );
  } else {
    lines.push(t('review.inputSummary.task'));
  }
  if (input.additionalWorkingDirs?.length) {
    lines.push(
      fill(t('review.inputSummary.additionalDirectories'), {
        dirs: input.additionalWorkingDirs.join(', '),
      }),
    );
  }
  if (input.artifactCount > 0) {
    lines.push(fill(t('review.inputSummary.artifacts'), { count: String(input.artifactCount) }));
  }
  const focus = input.focus?.replace(/\s+/g, ' ').trim();
  if (focus) {
    lines.push(
      fill(t('review.inputSummary.focus'), {
        focus: focus.length > MAX_FOCUS_CHARS ? `${focus.slice(0, MAX_FOCUS_CHARS)}…` : focus,
      }),
    );
  }
  return lines.join('\n');
}

/** The short line shown in the source task for the host-queued follow-up turn. */
export function reviewFollowUpDisplayText(findingsCount: number | null): string {
  return findingsCount && findingsCount > 0
    ? fill(t('review.followUp.withCount'), { count: String(findingsCount) })
    : t('review.followUp.unknownCount');
}

/**
 * Model input for the source task's follow-up turn. The Reviewer is independent
 * but can be wrong, so the source agent verifies every finding against the
 * current code before changing anything. The `[消息来源]` note is added at
 * dispatch from the queued origin, not here.
 */
export function buildReviewFollowUpMessage(result: string): string {
  const clipped =
    result.length > MAX_FOLLOW_UP_RESULT_CHARS
      ? `${result.slice(0, MAX_FOLLOW_UP_RESULT_CHARS)}\n…（审查结论过长，已截断；完整内容见审查卡片）`
      : result;
  return [
    '[审查结果] 用户运行了 /review。独立审查员（只读、不带开发记忆）对当前成果给出了以下结论。',
    '审查员可能误报：请逐条对照当前代码核实。属实的问题直接修复并做相应验证；误报说明依据，不要为迎合审查而改动正确的代码。处理完后简要汇报每条的处置。',
    '',
    '<review-result>',
    clipped.replace(/<\/?review-result>/gi, (tag) => tag.replace('<', '&lt;').replace('>', '&gt;')),
    '</review-result>',
  ].join('\n');
}
