import assert from 'node:assert/strict';

export default {
  name: 'voice-settings',
  entry: './voice-settings-fixture.tsx',
  viewport: { width: 460, height: 740 },
  real: 'CompanionVoiceSettings, SpeechVoicePicker, SpeechVoiceMenu, Slider, Select, FormField and theme tokens',
  notCovered:
    'Real preference persistence, provider requests, audio playback and microphone capture',
  stubs: {
    'src/renderer/lib/makerChatStore':
      'const empty = {}; export const EMPTY_LIGHT_STATE = empty; export const makerChatStore = { subscribeLight: () => () => {}, getLightSnapshot: () => empty };',
  },
  cases: {
    default: { about: 'ElevenLabs default 1× without an override', data: {} },
    narrow: {
      about: 'Saved speed in a narrow settings drawer',
      viewport: { width: 320, height: 820 },
      data: { speed: 0.95 },
    },
    minimax: {
      about: 'MiniMax native speed range',
      data: { protocol: 'minimax', modelId: 'speech-02-hd', speed: 1.5 },
    },
    openai: {
      about: 'OpenAI native speed range',
      data: { protocol: 'openai', modelId: 'gpt-4o-mini-tts', speed: 1.25 },
    },
    unsupported: {
      about: 'Eleven v3 keeps voice and preview but does not offer a speed slider',
      data: { modelId: 'eleven_v3' },
    },
    empty: {
      about: 'No models keeps only the existing setup introduction and provider link',
      data: { empty: true },
    },
    manual: {
      about: 'Custom voice keeps compact audition beside the input without a blur/save race',
      viewport: { width: 320, height: 900 },
      data: { manual: true, speed: 0.95 },
    },
    menu: {
      about: 'Preview an unselected voice without saving; keyboard and cancellation',
      data: { menu: true, speed: 0.95 },
    },
    'menu-narrow': {
      about: 'Long voice names and inline preview controls in a narrow drawer',
      viewport: { width: 320, height: 820 },
      data: { menu: true, speed: 0.95 },
    },
    'menu-error': {
      about: 'Failed preview stays in the menu without replacing the saved voice',
      data: { menu: true, previewFailure: true, speed: 0.95 },
    },
  },
  async ready(page) {
    const empty = await page.evaluate(() => window.__uiPage.ctx.data.empty);
    if (empty) await page.getByRole('button').first().waitFor();
    else if (await page.evaluate(() => window.__uiPage.ctx.data.manual)) {
      const label = await page.evaluate(() => window.__uiPage.t('bots.voiceMode.voiceId'));
      await page.getByRole('textbox', { name: label, exact: true }).waitFor();
    } else await page.getByText('River — Relaxed, Neutral, Informative').waitFor();
    if (await page.evaluate(() => window.__uiPage.ctx.data.menu)) {
      const label = await page.evaluate(() => window.__uiPage.t('bots.voiceMode.voice'));
      await page.getByRole('button', { name: label, exact: true }).click();
      await page.getByRole('dialog', { name: label }).waitFor();
    }
  },
  async check(page, ui) {
    const standalonePreview = page.getByRole('button', {
      name: await ui.t('bots.voiceMode.preview'),
      exact: true,
    });
    if (ui.data.manual) {
      const input = page.getByRole('textbox', {
        name: await ui.t('bots.voiceMode.voiceId'),
        exact: true,
      });
      const stop = page.getByRole('button', {
        name: await ui.t('bots.voiceMode.stopPreview'),
        exact: true,
      });
      const saved = () => page.evaluate(() => window.__uiPage.ctx.data.savedVoice);
      const preparing = page.getByText(await ui.t('bots.voiceMode.previewStatus.preparing'));
      await input.fill('custom-click');
      await standalonePreview.click();
      await preparing.waitFor();
      assert.equal(await saved(), 'custom-voice');
      await ui.capture('manual-preview');
      await stop.click();
      await standalonePreview.waitFor();
      await input.fill('custom-keyboard');
      await page.keyboard.press('Tab');
      assert.equal(await standalonePreview.evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press('Enter');
      await preparing.waitFor();
      const requests = await page.evaluate(() => window.__uiPage.ctx.data.previewRequests);
      assert.deepEqual(
        requests.map(({ voice, speed }) => ({ voice, speed })),
        [
          { voice: 'custom-click', speed: 0.95 },
          { voice: 'custom-keyboard', speed: 0.95 },
        ],
      );
      assert.equal(await saved(), 'custom-voice');
      await page.keyboard.press('Space');
      await standalonePreview.waitFor();
      await page.getByRole('slider', { name: await ui.t('bots.voiceMode.speed') }).focus();
      await page.waitForFunction(() => window.__uiPage.ctx.data.savedVoice === 'custom-keyboard');
      return;
    }
    assert.equal(await standalonePreview.count(), 0);
    if (ui.data.menu) {
      const label = await ui.t('bots.voiceMode.voice');
      const trigger = page.getByRole('button', { name: label, exact: true });
      const menu = page.getByRole('dialog', { name: label });
      const bella = 'Bella — Professional, Bright, Warm';
      const name = menu.getByRole('button', { name: bella, exact: true });
      const preview = menu.getByRole('button', {
        name: await ui.t('bots.voiceMode.previewVoice', { voice: bella }),
        exact: true,
      });
      const saved = () => page.evaluate(() => window.__uiPage.ctx.data.savedVoice);
      await name.hover();
      assert.equal(await preview.evaluate((el) => getComputedStyle(el).opacity), '1');
      assert.equal(await page.evaluate(() => window.__uiPage.ctx.data.previewRequests.length), 0);
      assert.equal(
        Math.round((await menu.boundingBox()).width),
        Math.round((await trigger.boundingBox()).width),
      );
      await ui.capture('hover-preview');
      // Native Tab reaches the distinct audition action without selecting the name.
      await name.focus();
      await page.keyboard.press('Tab');
      assert.equal(await preview.evaluate((el) => el === document.activeElement), true);
      await page.keyboard.press('Enter');
      await menu
        .getByText(
          await ui.t(
            `bots.voiceMode.previewStatus.${ui.data.previewFailure ? 'error' : 'preparing'}`,
          ),
          { exact: true },
        )
        .waitFor();
      assert.equal(await saved(), 'river');
      const requests = await page.evaluate(() => window.__uiPage.ctx.data.previewRequests);
      assert.equal(requests[0].voice, 'bella');
      assert.equal(requests[0].speed, 0.95);
      await ui.capture(ui.data.previewFailure ? 'preview-error' : 'preparing-preview');
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      assert.equal(await saved(), 'river');
      await page.waitForFunction(() => window.__uiPage.ctx.data.previewStops.length > 0);
      await trigger.focus();
      await page.keyboard.press('ArrowDown');
      await menu.waitFor();
      await name.click();
      await menu.waitFor({ state: 'hidden' });
      assert.equal(await saved(), 'bella');
      return;
    }
    const slider = page.getByRole('slider', { name: await ui.t('bots.voiceMode.speed') });
    if (ui.data.empty || ui.case === 'unsupported') {
      assert.equal(await slider.count(), 0);
      if (ui.case === 'unsupported')
        await page.getByText(await ui.t('bots.voiceMode.speedUnavailable')).waitFor();
      return;
    }
    const initial = ui.data.speed ?? 1;
    assert.equal(Number(await slider.getAttribute('aria-valuenow')), initial);
    await slider.focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(Number(await slider.getAttribute('aria-valuenow')), initial + 0.05);
    await ui.capture('adjusted');
    await page
      .getByRole('button', { name: await ui.t('bots.voiceMode.resetPreference'), exact: true })
      .click();
    assert.equal(Number(await slider.getAttribute('aria-valuenow')), 1);
  },
};
