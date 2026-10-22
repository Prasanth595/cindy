// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MailHtmlPreview, safeMailHtml } from '../MailHtmlPreview';
import { GhostCardForm } from '../GhostCardForm';
import { mailInlineBindingScript, mailInlineRefreshScript } from '@cindy/maker-shared/mail-text-edit';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../ImageLightbox', () => ({ ImageLightbox: ({ src }: { src: string }) => <img alt="attachment-preview" src={src} /> }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
// Opening a draft in the sidebar must not create a second modal editor or save it.
it('routes both HTML and plain-text enlargement to the shared mail panel', () => {
  const enlarge = vi.fn(), change = vi.fn();
  const view = render(<GhostCardForm fields={[{ name: 'bodyHtml', label: 'Body', kind: 'mail-html', value: '<p>Hello</p>' }]}
    disabled={false} onChange={change} onEnlarge={enlarge} />);
  fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.mailEnlarge' }));
  expect(enlarge).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).toBeNull();
  view.rerender(<GhostCardForm fields={[{ name: 'body', label: 'Body', multiline: true, value: 'Hello' }]}
    disabled={false} onChange={change} onEnlarge={enlarge} />);
  fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.mailEnlarge' }));
  expect(enlarge).toHaveBeenCalledTimes(2);
  expect(change).not.toHaveBeenCalled();
  view.rerender(<GhostCardForm fields={[{ name: 'body', label: 'Body', multiline: true, value: 'Hello' }]}
    disabled={false} onChange={change} onEnlarge={enlarge} expanded />);
  expect(screen.queryByRole('button', { name: 'chat.ghostCall.mailEnlarge' })).toBeNull();
});
// The sidebar previously inherited the compose card's 440px cap and left most
// of the reader empty. Body/font reflow and root margins were not covered by
// the image-load test, leaving a second scrolling viewport (unit regression).
it('lets the reader grow with long mail and late images while keeping chat cards compact', () => {
  const observers = new Map<Element, ResizeObserverCallback>();
  vi.stubGlobal('ResizeObserver', class {
    targets: Element[] = [];
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.targets.push(target); observers.set(target, this.callback); }
    disconnect() { this.targets.forEach(target => observers.delete(target)); }
  });
  const view = render(<MailHtmlPreview value="<p>Long mail</p>" reading />);
  const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement;
  const doc = frame.contentDocument!;
  doc.open(); doc.write(frame.srcdoc); doc.close();
  let height = 1500;
  Object.defineProperty(doc.body, 'scrollHeight', { get: () => height });
  Object.defineProperty(doc.documentElement, 'scrollHeight', { get: () => height + 40 });
  fireEvent.load(frame);
  expect(parseInt(frame.style.height)).toBeGreaterThanOrEqual(height + 40);
  height = 2000;
  doc.dispatchEvent(new Event('load'));
  expect(parseInt(frame.style.height)).toBeGreaterThanOrEqual(height + 40);
  height = 2400; // Fonts/reflow do not dispatch an image load event.
  observers.get(doc.body)!([], {} as ResizeObserver);
  expect(parseInt(frame.style.height)).toBeGreaterThanOrEqual(height + 40);
  height = 900;
  observers.get(doc.body)!([], {} as ResizeObserver);
  expect(parseInt(frame.style.height)).toBeLessThan(1000);
  view.unmount();
  expect(observers.has(doc.body)).toBe(false);
  render(<MailHtmlPreview value="<p>Long mail</p>" />);
  const card = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement;
  Object.defineProperty(card.contentDocument!.body, 'scrollHeight', { value: height });
  fireEvent.load(card);
  expect(parseInt(card.style.height)).toBeLessThan(height);
});
// Dark neutral backgrounds merge into the reading surface. Light mode keeps
// authored white paper intact so signature images/tables don't acquire seams.
// Theme changes must never reload the preview or save a draft (unit regression).
it('adapts authored mail colors to the app theme and restores them without changing content', async () => {
  const change = vi.fn();
  const original = '<body style="background-color: rgb(240, 235, 220); color: rgb(25, 60, 50)"><div style="background:white;color:black"><p>Hello</p></div><img src="cid:photo"></body>';
  const root = document.documentElement;
  const oldClass = root.className, oldStyle = root.getAttribute('style');
  try {
    root.classList.remove('dark');
    root.style.setProperty('--surface', '#f2f2ee');
    root.style.setProperty('--text-primary', '#262626');
    root.style.setProperty('--border-default', '#444444');
    render(<MailHtmlPreview value={original} onChange={change} />);
    const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement;
    const source = frame.srcdoc, doc = frame.contentDocument!;
    doc.open(); doc.write(source); doc.close(); fireEvent.load(frame);
    const paragraph = doc.querySelector('p'), image = doc.querySelector('img');
    const authored = doc.body.getAttribute('style');
    const neutral = doc.querySelector('div')!;
    expect(neutral.getAttribute('style')).toBe('background:white;color:black');
    expect(neutral.style.color).toBe('black');
    await act(async () => {
      root.classList.add('dark');
      root.style.setProperty('--surface', '#181818');
      root.style.setProperty('--text-primary', '#eeeeee');
    });
    expect(doc.body.style.backgroundColor).not.toBe('rgb(240, 235, 220)');
    expect(doc.body.style.color).not.toBe('rgb(25, 60, 50)');
    expect(neutral.style.backgroundColor).toBe('rgb(24, 24, 24)');
    expect(neutral.style.color).toBe('rgb(238, 238, 238)');
    expect(doc.body.style.backgroundColor).not.toBe(neutral.style.backgroundColor);
    expect(image?.getAttribute('style')).toBeNull();
    expect(frame.srcdoc).toBe(source);
    expect(doc.querySelector('p')).toBe(paragraph);
    await act(async () => {
      root.classList.remove('dark');
      root.style.setProperty('--surface', '#f2f2ee');
      root.style.setProperty('--text-primary', '#262626');
    });
    expect(doc.body.getAttribute('style')).toBe(authored);
    expect(neutral.getAttribute('style')).toBe('background:white;color:black');
    expect(neutral.style.color).toBe('black');
    expect(image?.getAttribute('style')).toBeNull();
    expect(frame.srcdoc).toBe(source);
    cleanup();
    expect(neutral.getAttribute('style')).toBe('background:white;color:black');
    expect(change).not.toHaveBeenCalled();
  } finally {
    root.className = oldClass;
    if (oldStyle === null) root.removeAttribute('style'); else root.setAttribute('style', oldStyle);
  }
});
// A new srcdoc can paint its authored light background before onLoad. Neither
// the reader nor the compose preview should reveal that unthemed document.
it('reveals each new document only after applying the initial dark theme', () => {
  const root = document.documentElement;
  const oldClass = root.className, oldStyle = root.getAttribute('style');
  const change = vi.fn();
  try {
    root.classList.add('dark');
    root.style.setProperty('--surface', '#181818');
    root.style.setProperty('--text-primary', '#eeeeee');
    const view = render(<MailHtmlPreview value='<body style="background:white;color:black"><p>Hello</p></body>' reading onChange={change} />);
    const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement;
    const load = () => {
      const doc = frame.contentDocument!;
      doc.open(); doc.write(frame.srcdoc); doc.close(); fireEvent.load(frame);
      expect(doc.documentElement.style.colorScheme).toBe('dark');
      expect(doc.body.style.backgroundColor).not.toBe('white');
      expect(frame.style.visibility).toBe('visible');
      expect(frame.getAttribute('aria-busy')).toBe('false');
    };
    expect(frame.style.visibility).toBe('hidden');
    load();
    const run = frame.contentDocument!.querySelector<HTMLElement>('[data-cindy-mail-run]')!;
    run.textContent = 'Edited'; fireEvent.input(run);
    view.rerender(<MailHtmlPreview value={change.mock.calls.at(-1)![0]} reading onChange={change} />);
    expect(frame.style.visibility).toBe('visible');
    expect(frame.contentDocument!.querySelector('[data-cindy-mail-run]')).toBe(run);
    view.rerender(<MailHtmlPreview value='<body style="background:white;color:black"><p>AI update</p></body>' reading onChange={change} />);
    expect(frame.style.visibility).toBe('hidden');
    expect(frame.getAttribute('aria-busy')).toBe('true');
    load();
    expect(change).toHaveBeenCalledTimes(1);
  } finally {
    root.className = oldClass;
    if (oldStyle === null) root.removeAttribute('style'); else root.setAttribute('style', oldStyle);
  }
});
it('inserts an existing image part into the HTML and hides its duplicate attachment tile', () => {
  const change = vi.fn(), url = `cindy-media://blobs/${'a'.repeat(64)}.png`;
  render(<GhostCardForm disabled={false} onChange={change} fields={[
    { name: 'bodyHtml', label: 'Body', kind: 'mail-html', value: '<html><body><p>Hello</p></body></html>' },
    { name: 'attachmentItems', label: 'Files', kind: 'mail-attachments', value: JSON.stringify([{ key: 'part', filename: 'card.png', mimeType: 'image/png', previewUrl: url }]) },
  ]} />);
  fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.mailInsertImage' }));
  const values = change.mock.calls.at(-1)![0];
  expect(values.bodyHtml).toContain('src="cid:image-1@cindy.local"');
  expect(values.bodyHtml).not.toContain('cindy-media:');
  expect(values.bodyHtml).toMatch(/<\/p><\/body><\/html>$/);
  expect(JSON.parse(values.attachmentItems)).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'chat.ghostCall.mailInsertImage' })).toBeNull();
  expect((screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement).srcdoc).toContain(url);
  expect(screen.queryByRole('button', { name: 'chat.ghostCall.mailRemoveAttachment' })).toBeNull();
  expect(JSON.parse(values.attachmentItems)[0].contentId).toBe('image-1@cindy.local');
});
it('keeps formatting and tables but removes executable content and unsafe URLs', () => {
  const safe = safeMailHtml('<p onclick="evil()" style="color:red;background-image:url(https://example.test/track)"><b>Hello</b></p><table><tr><td>Cell</td></tr></table><script>evil()</script><iframe src=x></iframe><a href="javascript:evil()">Link</a><img src="file:///private" onerror="evil()">');
  expect(safe).toContain('<b>Hello</b>'); expect(safe).toContain('<td>Cell</td>');
  expect(safe).not.toMatch(/evil|javascript|file:|url\(|onclick|onerror|iframe/);
});
// Opening preview alone never mutates the draft. Typing happens in the rendered
// text itself; author scripts remain blocked (unit regression).
it('enlarges the read-only preview and reflects later AI updates without changing the draft', () => {
  const fields = [{ name: 'bodyHtml', label: 'Body', kind: 'mail-html' as const, value: '<p>Original</p>' }];
  const change = vi.fn();
  const { rerender } = render(<GhostCardForm fields={fields} disabled={false} onChange={change} />);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('toolbar')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.mailEnlarge' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getAllByTitle('chat.ghostCall.mailPreview')).toHaveLength(2);
  rerender(<GhostCardForm fields={[{ ...fields[0], value: '<p>AI updated</p>' }]} disabled={false} onChange={change} />);
  expect(screen.getAllByTitle('chat.ghostCall.mailPreview').every(frame => frame.getAttribute('srcdoc')?.includes('AI updated'))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'chat.lightbox.close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(change).not.toHaveBeenCalled();
});
it('autosaves simple HTML text edits and the plain alternative, keeps the caret through echoes and locks sent mail', () => {
  const original = '<style>p{color:red}</style><p>Hello <b>Cherry</b></p><img src="cid:card">';
  const fields = [
    { name: 'bodyHtml', label: 'Body', kind: 'mail-html' as const, value: original },
    { name: 'body', label: 'Plain', kind: 'hidden' as const, value: 'Hello Cherry' },
  ];
  const change = vi.fn();
  const { rerender } = render(<GhostCardForm fields={fields} disabled={false} onChange={change} />);
  const frame = screen.getByTitle('chat.ghostCall.mailPreview') as HTMLIFrameElement;
  const src = frame.srcdoc;
  const doc = frame.contentDocument!;
  doc.open(); doc.write(src); doc.close(); fireEvent.load(frame);
  const input = doc.querySelector<HTMLElement>('[data-cindy-mail-run="0"]')!;
  expect(input.contentEditable).toBe('plaintext-only');
  fireEvent.compositionStart(input);
  input.textContent = '你好\n'; fireEvent.input(input);
  expect(change).not.toHaveBeenCalled();
  fireEvent.compositionEnd(input);
  const saved = change.mock.calls.at(-1)![0];
  expect(saved.body).toBe('你好\nCherry');
  expect(saved.bodyHtml).toContain('<p>你好<br><b>Cherry</b></p>');
  expect(saved.bodyHtml).toContain('<style>p{color:red}</style>');
  expect(saved.bodyHtml).toContain('src="cid:card"');
  expect(saved.bodyHtml).not.toContain('cindy-media:');
  rerender(<GhostCardForm fields={fields.map(f => ({ ...f, value: saved[f.name] }))} disabled={false} onChange={change} />);
  expect(frame.srcdoc).toBe(src);
  expect(doc.querySelector('[data-cindy-mail-run="0"]')).toBe(input);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('toolbar')).toBeNull();
  rerender(<GhostCardForm fields={fields.map(f => ({ ...f, value: saved[f.name] }))} disabled readOnly onChange={change} />);
  expect(input.contentEditable).toBe('false');
  const count = change.mock.calls.length;
  input.textContent = 'Should not save'; fireEvent.input(input);
  expect(change).toHaveBeenCalledTimes(count);
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: 'chat.ghostCall.mailEditText' })).toBeNull();
});
it('native WebView binding emits only composed plain text and respects the read-only switch', () => {
  const doc = document.implementation.createHTMLDocument('mail');
  doc.body.innerHTML = '<p><span data-cindy-mail-run="0">Hello</span></p>';
  const postMessage = vi.fn();
  new Function('document', 'window', mailInlineBindingScript(7))(doc, { ReactNativeWebView: { postMessage } });
  new Function('document', mailInlineRefreshScript(true, []))(doc);
  const text = doc.querySelector('span')!;
  text.dispatchEvent(new Event('compositionstart', { bubbles: true })); text.textContent = '你好'; text.dispatchEvent(new Event('input', { bubbles: true }));
  expect(postMessage).not.toHaveBeenCalled();
  text.dispatchEvent(new Event('compositionend', { bubbles: true }));
  expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({ type: 'mail-text', documentId: 7, id: '0', text: '你好' });
  new Function('document', mailInlineRefreshScript(false, []))(doc);
  text.dispatchEvent(new Event('input', { bubbles: true }));
  expect(postMessage).toHaveBeenCalledTimes(1);
});
it('keeps the attachment gesture outside the preview and hides it for sent mail', () => {
  const attach = vi.fn(), fields = [{ name: 'attachmentItems', label: 'Files', kind: 'mail-attachments' as const, value: '[]' }];
  const { rerender } = render(<GhostCardForm fields={fields} disabled={false} onChange={() => {}} onAttach={attach} />);
  fireEvent.click(screen.getByRole('button', { name: 'chat.ghostCall.mailAttach' }));
  expect(attach).toHaveBeenLastCalledWith(false);
  rerender(<GhostCardForm fields={fields} disabled readOnly onChange={() => {}} onAttach={attach} />);
  expect(screen.queryByRole('button', { name: 'chat.ghostCall.mailAttach' })).toBeNull();
});
it('retains a CID image without duplicate attachment controls or hidden metadata', () => {
  const change = vi.fn();
  render(<GhostCardForm fields={[
    { name: 'body', label: 'Plain', value: 'Body', kind: 'hidden' },
    { name: 'bodyHtml', label: 'Body', value: '<p>Body</p><img src="cid:image@example.test">', kind: 'mail-html' },
    { name: 'attachmentItems', label: 'Files', kind: 'mail-attachments', value: JSON.stringify([{ key: 'part', filename: 'photo.png', contentId: '<image@example.test>' }]) },
  ]} disabled={false} onChange={change} />);
  expect(screen.queryByLabelText('Plain')).toBeNull();
  expect(screen.queryByRole('button', { name: 'chat.ghostCall.mailRemoveAttachment' })).toBeNull();
  expect(change).not.toHaveBeenCalled();
});
// Regression: full HTML cards lost head CSS/body background and class selectors.
it('preserves the authored document and opens an image attachment without editing it', () => {
  const html = '<html><head><style>.card{border-radius:12px;background:linear-gradient(white,pink)}@media(max-width:400px){.card{padding:8px}}</style></head><body style="background-color: ivory"><div class="card">Card</div></body></html>';
  const safe = safeMailHtml(html);
  expect(safe).toContain('.card{border-radius:12px');
  expect(safe).toContain('class="card"');
  expect(safe).toContain('background-color: ivory');
  const url = `cindy-media://blobs/${'a'.repeat(64)}.png`, change = vi.fn();
  render(<GhostCardForm disabled={false} onChange={change} fields={[
    { name: 'attachmentItems', label: 'Files', kind: 'mail-attachments', value: JSON.stringify([{ key: 'part', filename: 'card.png', mimeType: 'image/png', bytes: 1024, previewUrl: url }]) },
  ]} />);
  fireEvent.click(screen.getByRole('button', { name: /card.png/ }));
  expect(screen.getByAltText('attachment-preview').getAttribute('src')).toBe(url);
  expect(change).not.toHaveBeenCalled();
});
