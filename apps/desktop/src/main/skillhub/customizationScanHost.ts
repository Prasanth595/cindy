import os from 'node:os';
import path from 'node:path';
import { app, utilityProcess } from 'electron';
import type { AgentCustomization, ListCustomizationsOptions, ListCustomizationsResult } from '@cindy/maker-core';
import { createLogger } from '../logger';
import { CustomizationScanClient } from './customizationScanClient';

const log = createLogger('skillhub:discovery');
const client = new CustomizationScanClient({
  fork: () => {
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      'PATH', 'SystemRoot', 'WINDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
      'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
    ]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    return utilityProcess.fork(path.join(__dirname, 'customizationScanProcess.js'), [], {
      serviceName: 'cindy-skill-discovery',
      env,
      cwd: os.tmpdir(),
      stdio: 'ignore',
    });
  },
});

let shutdownRegistered = false;

export async function scanLocalCustomizations(
  engine: AgentCustomization['engine'], options: ListCustomizationsOptions,
): Promise<ListCustomizationsResult> {
  if (!shutdownRegistered) {
    app.once('will-quit', () => client.dispose());
    shutdownRegistered = true;
  }
  const result = await client.scan(engine, options);
  if (result.errors.length > 0) log.warn('Customization discovery returned errors', { engine, count: result.errors.length });
  return result;
}
