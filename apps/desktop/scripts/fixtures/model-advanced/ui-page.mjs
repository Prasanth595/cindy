export default {
  name: 'model-advanced', entry:'./model-advanced-fixture.tsx',
  viewport:{width:1000,height:800},
  real:'ModelAdvancedDrawer, buildUnionRows, bundled per-engine reasoning metadata, preference writes, themes and translations',
  notCovered:'Account entitlement and live model calls; host context result and speed availability are fixture inputs',
  cases:{
    default:{about:'GPT-6 Astra with Codex Ultrafast entitlement'},
    'interface-reset':{about:'Explicit Kimi interface source and reset back to the current catalog default; in-memory save only'},
    sol:{about:'GPT-6.1 Sol with Codex Ultrafast entitlement'},
    'legacy-sol':{about:'GPT-6 Sol reasoning metadata'},
    unavailable:{about:'Account has not enabled Ultrafast'},
  },
  async check(page,ui) {
    if (ui.case === 'interface-reset') {
      await page.getByText(await ui.t('settings.providers.models.advanced.protocol.sourceModel'), {exact:true}).waitFor();
      const button = page.getByRole('button', {name: `Codex · ${await ui.t('settings.providers.custom.fields.wireProtocol')}`, exact:true});
      if (!(await button.textContent()).includes('Chat Completions')) throw Error('Explicit interface label differs from route');
      await ui.capture('explicit-interface');
      await button.click();
      await page.getByRole('menuitemradio', {name: await ui.t('settings.providers.models.advanced.protocol.automatic'), exact:true}).waitFor();
      await ui.capture('interface-menu');
      await page.getByRole('menuitem', {name: await ui.t('settings.providers.models.advanced.protocol.restoreRoute'), exact:true}).click();
      await page.getByText(await ui.t('settings.providers.models.advanced.protocol.sourceCatalog'), {exact:true}).waitFor();
      if (!(await button.textContent()).includes('Responses')) throw Error('Reset did not follow the catalog interface');
      await ui.capture('catalog-restored');
      return;
    }
    const ultra=page.getByRole('radio',{name:await ui.t('effortLevels.ultra'),exact:true});
    await ultra.waitFor();
    const clipped=await ultra.evaluate(el=>{
      const group=el.closest('[role=radiogroup]');
      const box=el.getBoundingClientRect(), bounds=group.getBoundingClientRect();
      return box.left<bounds.left || box.right>bounds.right || group.scrollWidth>group.clientWidth+1;
    });
    await ui.capture('initial');
    if(clipped) throw Error('Reasoning options are clipped or require horizontal scrolling');
    await ultra.click();
    if(await ultra.getAttribute('aria-checked')!=='true') throw Error('Ultra default was not saved');
    const speed = page.getByText(await ui.t('newChat.modelSelector.speed.ultrafast'), {exact:true});
    const capability = await speed.locator('..').textContent();
    const expected = ['unavailable', 'legacy-sol'].includes(ui.case) ? 'unsupported' : 'supported';
    if (!capability?.includes(await ui.t(`settings.providers.models.advanced.${expected}`))) {
      throw Error('Ultrafast capability does not match the account');
    }
    await ui.capture('ultra-selected');
  },
};
