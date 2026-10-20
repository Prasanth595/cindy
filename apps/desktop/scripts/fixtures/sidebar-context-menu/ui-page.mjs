import assert from 'node:assert/strict';

const sessions = [
  {
    id: 'dialogue-fixture',
    title: 'Plan the next release',
    workingDir: '',
    workspaceKind: 'dialogue',
  },
  {
    id: 'project-fixture',
    title: 'Review sidebar navigation',
    workingDir: '/workspace/Cindy',
    workspaceKind: 'project',
  },
].map((session) => ({
  ...session,
  agentKind: 'cc',
  status: 'active',
  createdAt: '2026-10-20T12:00:00Z',
  updatedAt: '2026-10-20T12:01:00Z',
  userSendAt: '2026-10-20T12:01:00Z',
  model: 'claude-sonnet-4-6',
  source: 'desktop',
}));

export default {
  name: 'sidebar-context-menu',
  entry: './sidebar-context-menu-fixture.tsx',
  viewport: { width: 800, height: 720 },
  real: 'CCAgentSidebarUpper, ProjectsSection/SessionGroupNode, ProjectNode, global display-settings menus',
  notCovered:
    'Full App root listeners, real IPC/storage, task creation persistence, device connections, Windows native menus',
  stubs: {
    'src/renderer/contexts/AuthContext': {
      partial:
        'export const useAuth=()=>({dataOwnerId:null,dataOwnerGeneration:0,user:null,isAuthenticated:false});',
    },
    'src/renderer/hooks/useCCSessions': `const sessions=${JSON.stringify(sessions)}; export const useCCSessions=()=>({sessions,isLoading:false,error:null,effectiveIncludeArchived:'active',refreshSessions:async()=>sessions,patchLocal:()=>{}});`,
  },
  cases: {
    default: {
      about: 'Dialogue header, project menu, blank-area sorting and global settings entry',
    },
  },
  async check(page, ui) {
    const title = page.getByText(await ui.t('ccAgent.sidebar.dialogues'), { exact: true });
    await title.click({ button: 'right' });
    await ui.capture('dialogue-right-click');
    assert.equal(
      await page.getByRole('menu').count(),
      0,
      'dialogue title must not open global sorting',
    );

    const header = title.locator('..').locator('..');
    const initial = await header.getAttribute('aria-expanded');
    await title.click();
    assert.notEqual(await header.getAttribute('aria-expanded'), initial);
    await header.press('Enter');
    assert.equal(await header.getAttribute('aria-expanded'), initial);
    await header.press('Space');
    assert.notEqual(await header.getAttribute('aria-expanded'), initial);

    const project = page.locator('[data-project-header]');
    await project.click({ button: 'right' });
    await page
      .getByRole('menuitem', {
        name: await ui.t('ccAgent.sidebar.projectAction.rename'),
        exact: true,
      })
      .waitFor();
    assert.equal(
      await page
        .getByRole('menuitem', {
          name: new RegExp(await ui.t('ccAgent.sidebar.filterProjectOrderHeading')),
        })
        .count(),
      0,
    );
    await ui.capture('project-menu');
    await page.keyboard.press('Escape');
    await project.dblclick();
    const input = project.getByRole('textbox');
    await input.waitFor();
    assert.equal(
      await input.evaluate((node) => {
        const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
        node.dispatchEvent(event);
        return event.defaultPrevented;
      }),
      false,
      'project rename keeps native editing menu available',
    );
    assert.equal(await page.getByRole('menu').count(), 0);
    await input.press('Escape');

    const scroll = page.locator('[data-ui-frame=sidebar] .overflow-y-auto').first();
    const box = await scroll.boundingBox();
    assert.ok(box);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 10, { button: 'right' });
    const projectSortLabel = await ui.t('ccAgent.sidebar.filterProjectOrderHeading');
    const projectSorting = () => page.getByRole('menuitem', { name: new RegExp(projectSortLabel) });
    await projectSorting().waitFor();
    await ui.capture('blank-sorting');
    await page.keyboard.press('Escape');

    await page.getByText(await ui.t('ccAgent.sidebar.allSessions'), { exact: true }).click();
    await page
      .getByRole('menuitem', { name: await ui.t('ccAgent.sidebar.organizeSidebar'), exact: true })
      .click();
    await projectSorting().waitFor();
    await ui.capture('all-tasks-settings');
    await page.keyboard.press('Escape');

    const expanded = await header.getAttribute('aria-expanded');
    await header.hover();
    await page
      .getByRole('button', { name: await ui.t('ccAgent.sidebar.newDialogue'), exact: true })
      .click();
    await page.locator('[data-fixture-route="/cc-agent/new"]').waitFor({ state: 'attached' });
    assert.equal(
      await header.getAttribute('aria-expanded'),
      expanded,
      'create must not toggle the group',
    );
  },
};
