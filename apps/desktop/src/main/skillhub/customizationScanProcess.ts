import {
  scanClaudeCustomizations, scanCodexCustomizations, scanPiCustomizations,
} from '@cindy/maker-core/customization-scanner';
import type { CustomizationScanRequest, CustomizationScanResponse } from './customizationScanProtocol';

interface ParentPort {
  postMessage(message: CustomizationScanResponse): void;
  once(event: 'message', listener: (event: { data: CustomizationScanRequest }) => void): void;
}

// A fixed, one-shot utility entry. It has no renderer bridge, credentials,
// managed-plugin resolver or write commands; discovery semantics stay in core.
const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
parentPort?.once('message', async ({ data: request }) => {
  if (request?.kind !== 'scan' || typeof request.id !== 'string') return;
  const scanners = {
    'claude-code': scanClaudeCustomizations,
    codex: scanCodexCustomizations,
    pi: scanPiCustomizations,
  };
  if (!Object.hasOwn(scanners, request.engine)) return;
  try {
    const result = await scanners[request.engine](request.options);
    parentPort.postMessage({ kind: 'result', id: request.id, result });
  } catch {
    parentPort.postMessage({
      kind: 'result', id: request.id,
      result: { items: [], errors: [{ message: `[${request.engine}] Customization discovery failed` }] },
    });
  }
});
