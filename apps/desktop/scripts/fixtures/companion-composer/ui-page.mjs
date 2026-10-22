import assert from 'node:assert/strict';

export default {
  name: 'companion-composer',
  entry: './companion-composer-fixture.tsx',
  viewport: { width: 760, height: 360 },
  real: 'ChatInput, Tiptap editor, SendButton, VoiceInputButton, tooltips, send dispatch, themes and translations',
  notCovered:
    'Microphone/ASR, live companion tasks and speech synthesis; host services, model catalog and dictation hook use scenario data. Windows runtime is not exercised.',
  stubs: {
    'src/renderer/hooks/useProviders': `const providers = [{ id: 'openai', name: 'OpenAI', source: 'builtin', connected: true, agents: ['codex'], auth: { method: 'oauth' }, routing: { codex: { upstream: 'https://example.test', authStrategy: 'oauth-passthrough' } }, models: { codex: [{ id: 'fixture-chat', name: 'Fixture', contextWindow: 200000, efforts: [], defaultEffort: null }] } }]; export const useProviders = () => ({ providers, loading: false });`,
    'src/renderer/hooks/useDeviceProviders': {
      partial: `export const useDeviceProviders = () => ({ providers: [], loading: false, unsupported: false });`,
    },
    'src/renderer/hooks/useConnectedSource': `export const useConnectedSource = () => ({ hasConnectedSource: true, loading: false });`,
    'src/renderer/hooks/useAvailableAgents': {
      partial: `export const useAvailableAgents = () => ({ agents: [], loading: false });`,
    },
    'src/renderer/hooks/useAgentCapabilities': {
      partial: `export const useAgentCapabilities = () => ({ capabilities: null, loading: false });`,
    },
    'src/renderer/components/new-chat/ExtraDirsButton': `export const ExtraDirsButton = () => null;`,
    'src/renderer/components/new-chat/PermissionSelector': `export const PermissionSelector = () => null;`,
    'src/renderer/components/new-chat/NewGoalDialog': `export const NewGoalDialog = () => null;`,
    'src/renderer/components/new-chat/AtMentionPanel': `export const AtMentionPanel = () => null;`,
    'src/renderer/components/new-chat/SlashCommandPalette': `export const SlashCommandPalette = () => null;`,
    'src/renderer/voice-input/useVoiceInput': `import { useState } from 'react'; export function useVoiceInput(editor) { const [state, setState] = useState('idle'); return { state, isListening: state === 'listening', isBusy: state !== 'idle', draftText: '', start: () => { setState('listening'); return true; }, stop: async () => { setState('idle'); editor?.commands.setContent('<p>Dictated message</p>'); }, cancel: async () => setState('idle') }; }`,
  },
  cases: {
    default: {
      about:
        'Empty/text/attachment action switch, stable target, keyboard send, call return and stop/queue',
    },
    narrow: {
      about: 'Same companion interactions at narrow width',
      viewport: { width: 360, height: 400 },
    },
  },
  async ready(page) {
    await page.locator('[contenteditable="true"]').waitFor();
  },
  async check(page, ui) {
    // Screenshot harness defaults to reduced motion; opt in to verify real transitions.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const editor = page.locator('[contenteditable]');
    const callName = await ui.t('bots.voiceMode.startConversation');
    const sendName = await ui.t('newChat.sendButton.send');
    const mic = page.getByRole('button', {
      name: await ui.t('newChat.chatInput.voiceInput.start'),
      exact: true,
    });
    const call = page.getByRole('button', { name: callName, exact: true });
    const send = page.getByRole('button', { name: sendName, exact: true });
    const micBefore = await mic.boundingBox();
    const slotBefore = await call.boundingBox();
    assert.equal(await send.count(), 0);
    assert.equal(slotBefore.width, 30);
    await call.click();
    await page.getByTestId('end-call').click();
    assert.equal(await call.evaluate((node) => node === document.activeElement), true);
    await editor.fill('   ');
    assert.equal(await call.count(), 1);
    // Sample the real transition rather than asserting Tailwind class strings.
    await editor.fill('Hello Cindy');
    assert.equal(await call.count(), 0);
    assert.equal(await send.isEnabled(), true);
    assert.deepEqual(await send.boundingBox(), slotBefore);
    assert.deepEqual(await mic.boundingBox(), micBefore);
    const motion = await send.evaluate((node) => {
      const icon = node.querySelector('svg.lucide-audio-lines').parentElement;
      return {
        duration: getComputedStyle(icon).transitionDuration,
        animations: icon.getAnimations().map((a) => a.effect.getKeyframes()),
      };
    });
    assert.equal(motion.duration, '0.25s');
    await send.evaluate(async (node) => {
      await Promise.all(
        node.getAnimations({ subtree: true }).map((animation) => animation.finished),
      );
    });
    assert.equal(
      await send.evaluate(
        (node) =>
          getComputedStyle(node.querySelector('svg.lucide-audio-lines').parentElement).transform,
      ),
      'matrix(0.55, 0, 0, 0.55, 0, 0)',
    );
    await ui.capture('typed');
    await send.click();
    await call.waitFor();
    assert.equal(await page.getByTestId('sent').textContent(), 'Hello Cindy');
    await editor.fill('Held Enter');
    await send.focus();
    await page.keyboard.down('Enter');
    await call.waitFor();
    // Playwright's second down is a native repeated keydown, not a synthetic click.
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    assert.equal(await page.getByTestId('end-call').count(), 0);
    assert.equal(await page.getByTestId('sent').textContent(), 'Held Enter');
    await page.getByTestId('attachment').click();
    await send.waitFor();
    await ui.capture('attachment');
    await page.getByTestId('attachment').click();
    await call.waitFor();
    await editor.fill('Keyboard message');
    await editor.press('Shift+Enter');
    assert.equal(await page.getByTestId('sent').textContent(), 'Held Enter');
    await editor.press('Enter');
    await call.waitFor();
    assert.equal((await page.getByTestId('sent').textContent()).trim(), 'Keyboard message');
    await page.getByTestId('running').click();
    const stop = page.getByRole('button', {
      name: await ui.t('newChat.sendButton.stop'),
      exact: true,
    });
    await stop.waitFor();
    assert.equal(await call.count(), 0);
    await editor.fill('Next message');
    await page
      .getByRole('button', { name: await ui.t('newChat.sendButton.queue'), exact: true })
      .waitFor();
    assert.equal(await stop.count(), 1);
    await ui.capture('queue');
    await stop.click();
    await editor.press('ControlOrMeta+A');
    await editor.press('Backspace');
    await call.waitFor();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await editor.fill('Reduced motion');
    assert.equal(
      await send.evaluate(
        (node) =>
          getComputedStyle(node.querySelector('svg.lucide-audio-lines').parentElement)
            .transitionDuration,
      ),
      '0s',
    );
    await editor.press('ControlOrMeta+A');
    await editor.press('Backspace');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  },
};
