export default {
  name: 'model-speed',
  entry: './model-speed-fixture.tsx',
  viewport: { width: 360, height: 500 },
  real: 'ModelConfigFlyout, Claude Fast billing confirmation, SpeedIcon, speed menu, themes and translations',
  notCovered: 'ModelSelector/UnifiedModelPanel routing, account entitlement, live model requests, database persistence and native mobile controls',
  cases: {
    default: { about: 'GPT-6 Astra: catalog reasoning levels and Ultrafast speed' },
    sol: { about: 'GPT-6.1 Sol: catalog reasoning levels and Ultrafast speed' },
    claude: { about: 'Claude Fast: extra usage warning, cancellation, confirmation and remembered dismissal' },
  },
  async check(page, ui) {
    if (ui.case === 'claude') {
      await page.evaluate(() => localStorage.removeItem('confirm-dialog.skip:claude-fast-mode-billing'));
      const toggle = page.locator('[data-fast-toggle]');
      const dialog = page.getByRole('alertdialog');
      await toggle.click();
      await dialog.waitFor();
      if (await toggle.getAttribute('aria-pressed') !== 'false') throw new Error('Claude Fast enabled before confirmation');
      await ui.capture('claude-fast-billing-warning');
      await dialog.getByRole('button', { name: await ui.t('commonUi.confirmDialog.cancel'), exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      if (await toggle.getAttribute('aria-pressed') !== 'false') throw new Error('Cancelled Claude Fast was enabled');
      await toggle.click();
      await dialog.getByRole('checkbox', { name: await ui.t('newChat.modelSelector.claudeFastWarning.dontShowAgain'), exact: true }).check();
      await ui.capture('claude-fast-remember-choice');
      await dialog.getByRole('button', { name: await ui.t('newChat.modelSelector.claudeFastWarning.confirm'), exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      if (await toggle.getAttribute('aria-pressed') !== 'true') throw new Error('Confirmed Claude Fast was not enabled');
      await toggle.click();
      if (await toggle.getAttribute('aria-pressed') !== 'false') throw new Error('Claude Fast could not be disabled');
      await toggle.click();
      await page.waitForFunction(() => document.querySelector('[data-fast-toggle]')?.getAttribute('aria-pressed') === 'true');
      if (await dialog.isVisible()) throw new Error('Remembered Claude Fast confirmation was shown again');
      return;
    }
    const button = page.getByRole('button', { name: await ui.t('newChat.modelSelector.speed.label'), exact: true });
    await button.click();
    await page.getByRole('menuitemradio', { name: await ui.t('newChat.modelSelector.speed.ultrafast'), exact: true }).waitFor();
    await ui.capture('speed-menu');
    await page.getByRole('menuitemradio', { name: await ui.t('newChat.modelSelector.speed.standard'), exact: true }).click();
    if (await button.getAttribute('title') !== await ui.t('newChat.modelSelector.speed.standard')) throw new Error('Standard selection was lost');
    await button.click();
    await page.getByRole('menuitemradio', { name: await ui.t('newChat.modelSelector.speed.fast'), exact: true }).click();
    if (await button.getAttribute('title') !== await ui.t('newChat.modelSelector.speed.fast')) throw new Error('Fast selection was lost');
    await button.click();
    await page.getByRole('menuitemradio', { name: await ui.t('newChat.modelSelector.speed.ultrafast'), exact: true }).click();
    if (await button.getAttribute('title') !== await ui.t('newChat.modelSelector.speed.ultrafast')) throw new Error('Ultrafast selection was lost');
    const slider = page.getByRole('slider');
    await slider.focus();
    await slider.press('End');
    if (await slider.getAttribute('aria-valuetext') !== 'Ultra') throw new Error('Catalog Ultra reasoning level was lost');
    await page.mouse.click(8, 8);
    await slider.hover();
    await ui.capture('ultra-reasoning');
  },
};
