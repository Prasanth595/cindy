export default {
  name: 'ignored-dirs-toggle',
  entry: './ignored-dirs-toggle-fixture.tsx',
  viewport: { width: 460, height: 560 },
  real: 'FileTreeIgnoredDirsToggle, useFileBrowserPreference, useFileTree scoped stores, FileTreeView, themes and translations',
  notCovered: 'device-link transport, real daemon watcher and native mobile',
  cases: {
    default: { about: '「显示被忽略的目录」开关:关(隐藏 node_modules/.git)→ 开(显示)前后' },
  },
  async check(page, ui) {
    const toggle = page.getByRole('button', { name: await ui.t('ccAgent.workdirBrowse.treeAction.showIgnoredDirs'), exact: true });
    await toggle.waitFor();
    await page.getByText('src', { exact: true }).waitFor();
    // 关:内置忽略目录不在树里。
    if (await page.getByText('node_modules', { exact: true }).count()) {
      throw new Error('node_modules should be hidden while the toggle is off');
    }
    await ui.capture('toggle-off');
    await toggle.click();
    await page.getByText('node_modules', { exact: true }).waitFor();
    if (!(await page.getByText('.git', { exact: true }).count())) {
      throw new Error('.git should appear while the toggle is on');
    }
    await ui.capture('toggle-on');
  },
};
