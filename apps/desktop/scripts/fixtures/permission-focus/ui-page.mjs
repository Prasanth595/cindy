import assert from 'node:assert/strict';

export default {
  name: 'permission-focus',
  entry: './permission-focus-ui-fixture.tsx',
  viewport: { width: 1280, height: 760 },
  real: 'SessionItem, SessionCard, CardMasonry, SessionEntryList plain-session branch, pointer focus handoff, PermissionPrompt and keyboard ownership guard; official mountPage themes and MemoryRouter',
  notCovered: 'Synthetic navigation shell, already-open rail panel and synthetic permission responses; not full App, CCAgentSessionView, SplitGroup ownership predicate, RailPanels lifecycle/portal, ProjectsSection, automation-group branch, group-chat shortcuts, Windows or independent sidebar window. Import graph reachability is not rendered coverage. WorktreeBadge and host data modules listed in stubs are replaced.',
  // build.mjs records actual matched replacements in manifest.replaced. Keep this
  // explicit: loaded dependencies and declared-but-unused stubs are not UI coverage.
  stubs: {
    'src/renderer/contexts/AuthContext':
      'export const useAuth=()=>({dataOwnerId:"synthetic",isAuthenticated:true});',
    'src/renderer/contexts/PrRefsContext':
      'const empty=[];const actions={registerPrConsumer:()=>()=>{}};export const usePrRefsForSession=()=>empty;export const usePrActions=()=>actions;export const usePrStatus=()=>undefined;export const usePrStatuses=()=>({statuses:new Map(),fetchStatusesForSession(){}});',
    'src/renderer/features/scheduler/lib/scheduleSessionBinding':
      'const empty=[];export const useSessionBoundSchedules=()=>empty;export const scheduleFocusPath=()=>"/";',
    'src/renderer/features/scheduler/lib/scheduleSidebarIndexRuns':
      'export const loadScheduleSidebarIndexRuns=async()=>[];export const findLatestSidebarIndexRunForSession=()=>undefined;',
    'src/renderer/components/sidebar/WorktreeBadge': 'export const WorktreeBadge=()=>null;',
    'src/renderer/contexts/WorktreeContext':
      'const noop=()=>{};export const useWorktreeForSession=()=>null;export const useReportWorktreeLiveness=()=>noop;export const useObservedWorktreeForSession=()=>null;export const useRefreshObservedWorktree=()=>noop;',
    'src/renderer/lib/makerChatStore':
      'const running=new Map();export const makerChatStore={ensureInitialMessages(){},hasPausedQueue:()=>false,subscribeAll:()=>()=>{},getRunningSnapshot:()=>running};',
    'src/renderer/lib/toast': 'export const toast={success(){},warning(){},error(){}};',
  },
  cases: {
    default: { about: 'SessionItem: pointer A→B then Enter', data: { layout: 'rows', panelWidth: 240, columns: 1 } },
    rail: { about: '64px synthetic rail, already-open 240px panel with real cards', data: { layout: 'rail', panelWidth: 240, columns: 1 } },
    one: { about: 'One-column real CardMasonry', data: { layout: 'one', panelWidth: 240, columns: 1 } },
    two: { about: 'Two-column real CardMasonry', data: { layout: 'two', panelWidth: 340, columns: 2 } },
    three: { about: 'Three-column real CardMasonry', data: { layout: 'three', panelWidth: 466, columns: 3 } },
    'files-row': { about: 'Files A→chat A, highlighted SessionEntryList row persists', data: { layout: 'rows', panelWidth: 240, columns: 1, fromFiles: true } },
    'files-card': { about: 'Files A→chat A, highlighted SessionEntryList card persists', data: { layout: 'list', panelWidth: 240, columns: 1, fromFiles: true } },
  },
  async ready(page) {
    await page.locator('[data-session-id="F"]').waitFor();
    await page.locator('[data-fixture-permission="B"]').waitFor();
  },
  async check(page, ui) {
    const fromFiles = ui.data.fromFiles === true;
    const target = fromFiles ? 'A' : 'B';
    const entries = page.locator('[data-fixture-entries]');
    const rows = entries.locator('[data-sidebar-session-row][data-session-id]');
    assert.equal(await rows.count(), 6);
    // Measure rendered card positions, not configured widths or a copied column algorithm.
    const measure = () => entries.evaluate((node) => {
      const items = [...node.querySelectorAll('[data-sidebar-session-row][data-session-id]')];
      const rects = items.map((item) => item.getBoundingClientRect());
      const lefts = [...new Set(rects.map((rect) => Math.round(rect.left)))];
      return {
        contentWidth: node.clientWidth,
        masonryWidth: node.firstElementChild?.clientWidth,
        columns: lefts.length,
        cardWidths: rects.map((rect) => rect.width),
        fits: rects.every((rect) => rect.left >= node.getBoundingClientRect().left - 1
          && rect.right <= node.getBoundingClientRect().right + 1),
      };
    });
    const dimensions = await measure();
    assert.equal(dimensions.columns, ui.data.columns, JSON.stringify(dimensions));
    assert.ok(dimensions.fits && dimensions.cardWidths.every((width) => width > 0), JSON.stringify(dimensions));
    assert.equal(await page.locator('[data-fixture-panel]').evaluate((node) => node.getBoundingClientRect().width), ui.data.panelWidth);
    const masonry = !fromFiles && ui.data.layout !== 'rows';
    if (masonry) {
      assert.equal(dimensions.masonryWidth, dimensions.contentWidth);
      const width = dimensions.masonryWidth;
      if (ui.data.columns === 1) assert.ok(width > 0 && width < 246, `one-column width=${width}`);
      if (ui.data.columns === 2) assert.ok(width >= 246 && width < 390, `two-column width=${width}`);
      if (ui.data.columns === 3) assert.ok(width >= 390, `three-column width=${width}`);
    }
    if (ui.case === 'rail') assert.equal(await page.locator('[data-fixture-rail]').evaluate((node) => node.getBoundingClientRect().width), 64);
    const route = page.locator('[data-fixture-route]');
    assert.equal(await route.textContent(), fromFiles ? '/cc-agent/files/A' : '/cc-agent/A');
    const row = entries.locator(`[data-session-id="${target}"]`);
    const original = await row.elementHandle();
    assert.ok(original, 'Target sidebar node is mounted');
    const beforeHighlight = await row.evaluate((node) => getComputedStyle(node).backgroundColor);
    if (fromFiles) {
      assert.equal(await row.getAttribute('aria-current'), 'page');
      const otherHighlight = await entries.locator('[data-session-id="B"]').evaluate((node) => getComputedStyle(node).backgroundColor);
      assert.notEqual(beforeHighlight, otherHighlight, 'Files A keeps its visible selection highlight');
    }
    await ui.capture(`initial-w${dimensions.contentWidth}-cols${dimensions.columns}`);
    // Click the real row/card; never blur/focus programmatically or click chat afterwards.
    await row.click({ position: { x: 16, y: 12 } });
    await page.waitForFunction((id) =>
      document.querySelector('[data-fixture-route]')?.textContent === `/cc-agent/${id}`
      && document.activeElement === document.body, target);
    assert.equal(await route.getAttribute('data-active-session'), target);
    assert.equal(await row.getAttribute('aria-current'), 'page');
    assert.equal(await row.evaluate((node, previous) => node === previous, original), true,
      'Navigation must preserve the real sidebar node');
    if (fromFiles) assert.equal(await row.evaluate((node) => getComputedStyle(node).backgroundColor), beforeHighlight);
    await original.dispose();
    assert.deepEqual(await measure(), dimensions, 'Navigation preserves actual layout');
    const responses = page.locator('[data-fixture-responses]');
    assert.deepEqual(JSON.parse(await responses.getAttribute('data-fixture-responses')), []);
    await ui.capture('after-pointer-navigation');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const raw = document.querySelector('[data-fixture-responses]')?.getAttribute('data-fixture-responses');
      return raw && JSON.parse(raw).length > 0;
    });
    assert.deepEqual(JSON.parse(await responses.getAttribute('data-fixture-responses')),
      [{ session: target, request: `request-${target}`, decision: { behavior: 'allow' } }],
      'Only the current request responds; the other mounted permission stays inactive');
    await ui.capture('after-enter');
  },
};
