import assert from 'node:assert/strict';

export default {
  name: 'migration-prompt',
  entry: './migration-prompt-fixture.tsx',
  viewport: { width: 800, height: 600 },
  real: 'CrossAgentConvertDialog, useCrossAgentMigrationDialog, MigrationPromptSection and theme tokens',
  notCovered: 'Native CLI detection, filesystem persistence, real IPC, task creation and full Settings navigation; host APIs use isolated fixture data',
  cases: {
    default: { about: 'Instruction conversion with persistent workspace choice', data: {} },
    mixed: { about: 'Hiding instructions leaves hooks conversion available', data: { mixed: true } },
    narrow: { about: 'Dialog at 360px width', viewport: { width: 360, height: 640 }, data: {} },
    recovery: { about: 'Restore only the chosen workspace', data: { recovery: true } },
    'recovery-narrow': { about: 'Long paths at 360px width', viewport: { width: 360, height: 640 }, data: { recovery: true } },
  },
  async ready(page) {
    await page.getByText(/AGENTS.md/).first().waitFor();
  },
  async check(page, ui) {
    if (ui.data.recovery) {
      const buttons = page.getByRole('button');
      assert.equal(await buttons.count(), 2);
      await buttons.first().click();
      await page.getByText('C:\\Workspace\\project', { exact: true }).waitFor({ state: 'hidden' });
      assert.equal(await buttons.count(), 1);
      return;
    }
    await page.getByRole('button', { name: await ui.t('commonUi.crossAgentConvert.suppressAgentsMd'), exact: true }).click();
    await page.getByText('AGENTS.md → CLAUDE.md', { exact: true }).waitFor({ state: 'hidden' });
    if (ui.case === 'mixed') {
      assert.equal(await page.getByRole('alertdialog').count(), 1);
      await page.getByText('Codex hooks → Claude hooks', { exact: true }).waitFor();
    } else {
      await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
    }
  },
};
