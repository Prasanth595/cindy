import { mountPage, forbid } from '../../ui-page/harness';
import { RemoteSection } from '../../../src/renderer/components/settings/RemoteSection';
import { ToastContainer } from '../../../src/renderer/components/ui/toast/ToastContainer';

void mountPage({
  host: (ctx) => {
    const listeners = new Set<(snapshot: RemoteHostSnapshot) => void>();
    const initial = ctx.data.host as RemoteHostSnapshot;
    const failed = ctx.data.failed as RemoteHostSnapshot;
    return {
      remoteSsh: {
        list: async () => ({ hosts: [initial] }),
        onStatusChanged: (listener: (snapshot: RemoteHostSnapshot) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        // Simulate only the host boundary: the real connect handler consumes
        // the failed status push before receiving the IPC rejection.
        connect: async () => {
          for (const listener of listeners) listener(failed);
          throw new Error(`[SSH_AUTH_FAILED] ${failed.lastError}`);
        },
        add: forbid('remoteSsh.add'),
        remove: forbid('remoteSsh.remove'),
        update: forbid('remoteSsh.update'),
        disconnect: forbid('remoteSsh.disconnect'),
        reloadConfig: forbid('remoteSsh.reloadConfig'),
        setAutoConnect: forbid('remoteSsh.setAutoConnect'),
      },
    };
  },
  render: () => (
    <main className="min-h-screen bg-content-area p-6">
      <RemoteSection />
      <ToastContainer />
    </main>
  ),
});
