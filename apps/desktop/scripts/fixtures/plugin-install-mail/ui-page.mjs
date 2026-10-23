export default {
  name: 'plugin-install-mail',
  entry: './fixture.tsx',
  viewport: { width: 700, height: 600 },
  real: 'MailPreviewBody provider chooser and unavailable/failed reader states, GhostInstallConsentHost, shared confirmation dialog, buttons and five locales',
  notCovered:
    'Mailbox tools, installer writes, account credentials, mail bodies, native mobile rendering and network connections',
  stubs: {
    'src/renderer/features/right-sidebar/lib/mailPreview':
      'export async function readMailPreview(){ const c=window.__uiPage.ctx.case; if(c==="no-reader")return {supported:false}; if(c==="not-ready")return {supported:true,error:"MAIL_PROVIDER_NOT_READY"}; if(c==="read-failed")return {supported:true,error:"MAIL_READ_FAILED"}; return {providers:[{id:"root",name:"Mail",namespace:null},{id:"team",name:"Mail for a very long organization name",namespace:"long-organization-identity-example"}]}; }',
    'src/renderer/features/right-sidebar/registry': 'export function registerTabKind(){} export function getTabKind(){return undefined;}',
    'src/renderer/features/right-sidebar/plugins/mail-preview/MailCardBody':
      'export function MailCardBody(){return null;}',
    'src/renderer/features/right-sidebar/plugins/mail-preview/MailConversationView':
      'export function MailConversationView(){return null;}',
  },
  cases: {
    'two-mail-views': { about: 'Typing in either editor updates its peer without iframe navigation or blank paint' },
    'edit-mail-body': { about: 'Native whole-body selection, replace, delete, undo, and saved HTML round trip' },
    'refresh-mail-body': { about: 'Source updates with identical sanitized HTML must reveal the mail body' },
    'expanded-recipients': { about: 'Sidebar recipient rows retain expand/collapse with compact spacing', viewport: { width: 360, height: 600 } },
    default: { about: 'Two configured plugin instances' },
    narrow: {
      about: 'Long organization and plugin names in a narrow sidebar',
      viewport: { width: 360, height: 600 },
    },
    'source-change': { about: 'Source replacement and duplicate account impact' },
    'no-reader': { about: 'A restored tab with no mail plugin; original URL remains accessible', viewport: { width: 360, height: 600 } },
    'not-ready': { about: 'An unconfigured mail plugin without a pointless retry', viewport: { width: 360, height: 600 } },
    'read-failed': { about: 'A real read failure offers both original URL and retry', viewport: { width: 360, height: 600 } },
  },
  async check(page, ui) {
    const selected = await page.evaluate(() => window.__uiPage.ctx.case);
    if (selected === 'two-mail-views') {
      await page.waitForFunction(() => document.querySelectorAll('iframe[aria-busy="false"]').length === 2);
      await page.evaluate(() => {
        window.mailViewProof = [...document.querySelectorAll('iframe')].map(frame => {
          const proof = { frame, doc: frame.contentDocument, src: frame.srcdoc, loads: 0 };
          frame.addEventListener('load', () => proof.loads++);
          return proof;
        });
      });
      for (const side of [1, 0, 1]) {
        const body = page.getByTestId(`mail-side-${side}`).frameLocator('iframe').locator('body');
        await body.getByText('Last paragraph', { exact: true }).click();
        await page.keyboard.press('End');
        await page.keyboard.type(' xyz');
        await page.waitForFunction(() => {
          const frames = [...document.querySelectorAll('iframe')];
          const text = frames[0].contentDocument.body.textContent;
          return text.includes(' xyz') && text === frames[1].contentDocument.body.textContent;
        });
        const stable = await page.evaluate(() => window.mailViewProof.every(p =>
          p.frame.isConnected && p.frame.contentDocument === p.doc && p.frame.srcdoc === p.src &&
          p.loads === 0 && p.frame.style.visibility === 'visible' && p.frame.getAttribute('aria-busy') === 'false'));
        if (!stable) throw new Error('Peer editor navigated or hid during synchronization');
        // Undo the last keystroke and check that the receiving view follows it.
        await page.keyboard.press('ControlOrMeta+z');
        await page.waitForFunction(() => [...document.querySelectorAll('iframe')].every(frame => frame.contentDocument.body.textContent === 'First paragraphLast paragraph'));
      }
      await ui.capture('synced');
      return;
    }
    // Browser integration: the former per-run editor only selected one run.
    // Exercise actual keyboard editing and the onChange/autosave echo, not DOM mocks.
    if (selected === 'edit-mail-body') {
      await page.locator('iframe[aria-busy="false"]').waitFor();
      const body = page.frameLocator('iframe');
      await body.getByText('Last paragraph', {exact: true}).click();
      await page.keyboard.press('End');
      await page.keyboard.press('Enter');
      await page.keyboard.type('New paragraph');
      await page.waitForFunction(() => document.querySelector('[data-testid="saved-body"]').textContent.includes('New paragraph'));
      const split = await page.getByTestId('saved-body').textContent();
      if (split.includes('color-mix') || split.includes('data-cindy') || split.includes('!important')) throw new Error('Native paragraph insertion saved preview paint');
      await body.getByText('formatted', {exact: true}).click();
      const selectAll = async () => {
        await page.keyboard.press('ControlOrMeta+a');
        const selection = await page.evaluate(() => document.querySelector('iframe').contentDocument.getSelection().toString());
        if (!selection.includes('First paragraph') || !selection.includes('Last paragraph')) throw new Error('Selection is not the entire body');
      };
      await selectAll();
      await page.keyboard.type('Replacement text');
      await page.waitForFunction(() => document.querySelector('[data-testid="saved-body"]').textContent.includes('Replacement text'));
      let saved = await page.getByTestId('saved-body').textContent();
      if (saved.includes('First paragraph') || saved.includes('Last paragraph')) throw new Error('Replacement retained old text');
      await page.keyboard.press('ControlOrMeta+z');
      await page.waitForFunction(() => document.querySelector('[data-testid="saved-body"]').textContent.includes('Last paragraph'));
      await selectAll();
      await page.keyboard.press('Backspace');
      await page.waitForFunction(() => !document.querySelector('[data-testid="saved-body"]').textContent.includes('Last paragraph'));
      await page.keyboard.press('ControlOrMeta+z');
      await page.waitForFunction(() => document.querySelector('[data-testid="saved-body"]').textContent.includes('Last paragraph'));
      saved = await page.getByTestId('saved-body').textContent();
      // Native paragraph insertion may normalize #123456 to rgb(18, 52, 86).
      // Verify the authored color rather than its equivalent CSS spelling.
      const savedColor = await page.evaluate(html => new DOMParser().parseFromString(html, 'text/html').body.style.color, saved);
      if (!saved.includes('cid:logo') || saved.includes('data:image') || saved.includes('data-cindy') || savedColor !== 'rgb(18, 52, 86)') throw new Error(`Saved HTML leaked preview state or lost authored styles/CID: ${saved}`);
      await page.getByRole('button', {name:'Reopen saved'}).click();
      await page.locator('iframe[aria-busy="false"]').waitFor();
      await body.getByText('formatted', {exact:true}).waitFor();
      await body.getByText('formatted', {exact:true}).click();
      await selectAll();
      await page.evaluate(() => {
        const doc = document.querySelector('iframe').contentDocument;
        const data = new DataTransfer();
        data.setData('text/plain', '你好\nSecond line <script>literal</script>');
        doc.activeElement.dispatchEvent(new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: data}));
      });
      await page.waitForFunction(() => document.querySelector('[data-testid="saved-body"]').textContent.includes('你好'));
      saved = await page.getByTestId('saved-body').textContent();
      if (saved.includes('<script>') || saved.includes('First paragraph') || saved.includes('color-mix')) throw new Error('Paste was not plain text or saved preview paint');
      await page.getByRole('button', {name:'Reopen saved'}).click();
      await page.locator('iframe[aria-busy="false"]').waitFor();
      const rendered = await page.evaluate(() => document.querySelector('iframe').contentDocument.body.innerText);
      if (!rendered.includes('你好\n') || !rendered.includes('<script>literal</script>')) throw new Error('Multiline paste did not survive saving');
      return;
    }
    if (selected === 'refresh-mail-body') {
      await page.locator('iframe[aria-busy="false"]').waitFor();
      await page.getByRole('button', { name: 'Refresh source' }).click();
      await page.locator('iframe[aria-busy="false"]').waitFor();
      if (!await page.locator('iframe').isVisible()) throw new Error('Refreshed body stayed hidden');
      const text = await page.evaluate(() => document.querySelector('iframe').contentDocument.body.textContent);
      if (!text.includes('First paragraph') || !text.includes('Last paragraph')) throw new Error('Body content lost');
      return;
    }
    if (selected === 'expanded-recipients') {
      await page.locator('button[aria-expanded="false"]').click();
      for (const label of ['To', 'Cc', 'Bcc']) await page.getByRole('textbox', { name: label, exact: true }).waitFor();
      await ui.capture('expanded');
      await page.locator('button[aria-expanded="true"]').click();
      await page.locator('button[aria-expanded="false"]').waitFor();
      return;
    }
    const message = { 'no-reader': 'unavailable', 'not-ready': 'notReady', 'read-failed': 'failed' }[selected];
    if (message) {
      await page.getByText(await ui.t(`mailReader.${message}`)).waitFor();
      await page.getByRole('button', { name: await ui.t('mailReader.openMailbox'), exact: true }).waitFor();
      return;
    }
    if (selected !== 'source-change') {
      await page.getByText(await ui.t('mailReader.choosePlugin')).waitFor();
      return;
    }
    await ui.emit('installConsent', {
      requestId: 'fixture-install',
      initiator: 'user',
      origin: 'local-file',
      target: { namespace: null, sourceChanged: true, otherCopies: 1 },
      facts: {
        kind: 'update',
        ghostId: 'mail-fixture',
        name: 'Mail',
        version: '2.0.0',
        previousVersion: '1.0.0',
        added: [],
        removed: [],
        unchangedCount: 2,
        builtinOauthClientChanged: false,
      },
    });
    await page
      .getByRole('button', {
        name: await ui.t('settings.ghosts.installConsent.confirmUpdate'),
        exact: true,
      })
      .waitFor();
    await ui.capture('confirmation');
  },
};
