import { mountPage, subscription } from '../../ui-page/harness';
import { MailPreviewBody } from '../../../src/renderer/features/right-sidebar/plugins/mail-preview';
import { GhostInstallConsentHost } from '../../../src/renderer/cindy-brain/GhostInstallConsentHost';
import { GhostCardForm } from '../../../src/renderer/components/chat/GhostCardForm';
import { MailHtmlPreview } from '../../../src/renderer/components/chat/MailHtmlPreview';
import { useState } from 'react';

function MailTwoViewsFixture() {
  const [value, setValue] = useState('<p>First paragraph</p><p>Last paragraph</p>');
  return <div className="grid grid-cols-2 gap-4">
    {[0, 1].map(side => <section key={side} data-testid={`mail-side-${side}`}>
      <p>{side ? 'Sidebar editor' : 'Chat card'}</p>
      <MailHtmlPreview value={value} onChange={html => setValue(html)} />
    </section>)}
  </div>;
}

function MailRefreshFixture() {
  const [version, setVersion] = useState(0);
  return <>
    <button onClick={() => setVersion(version + 1)}>Refresh source</button>
    <MailHtmlPreview value={`<p>First paragraph</p><p>Last paragraph</p><!--${version}-->`} onChange={() => {}} />
  </>;
}

function MailEditFixture() {
  const [value, setValue] = useState('<html><head><style>p{margin:12px 0}</style></head><body style="color:#123456"><p>First paragraph</p><p>Second <strong>formatted</strong> paragraph</p><p>Last paragraph</p><img src="cid:logo"></body></html>');
  const [saved, setSaved] = useState('');
  const [instance, setInstance] = useState(0);
  return <>
    <button onClick={() => setInstance(instance + 1)}>Reopen saved</button>
    <MailHtmlPreview key={instance} value={value} images={[{cid: 'logo', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='}]} onChange={html => { setValue(html); setSaved(html); }} />
    <output data-testid="saved-body" hidden>{saved}</output>
  </>;
}

void mountPage({
  host: {
    ghosts: {
      onInstallConsentRequest: subscription('installConsent'),
      onInstallConsentDismissed: subscription('installDismissed'),
      resolveInstallConsent: async () => ({ handled: true }),
    },
  },
  render: (ctx) => (
    <main className="h-screen w-full">
      {ctx.case === 'two-mail-views' ? (
        <MailTwoViewsFixture />
      ) : ctx.case === 'edit-mail-body' ? (
        <MailEditFixture />
      ) : ctx.case === 'refresh-mail-body' ? (
        <MailRefreshFixture />
      ) : ctx.case === 'expanded-recipients' ? (
        <GhostCardForm expanded disabled={false} onChange={() => {}} fields={[
          { name: 'to', label: 'To', kind: 'recipients', value: 'Alex <alex@example.test>' },
          { name: 'cc', label: 'Cc', kind: 'recipients', value: '' },
          { name: 'bcc', label: 'Bcc', kind: 'recipients', value: 'private@example.test', collapsed: true },
        ]} />
      ) : ctx.case === 'source-change' ? (
        <GhostInstallConsentHost />
      ) : (
        <MailPreviewBody
          state={{ url: 'https://mail.example.test/a' }}
          ctx={{
            tabId: 'mail',
            sessionId: 'fixture',
            workdir: '',
            remoteHostId: null,
            deviceLinkDeviceId: null,
            patchState() {},
            onVisibilityChange() {},
            setCloseInterceptor: () => () => {},
          }}
        />
      )}
    </main>
  ),
});
