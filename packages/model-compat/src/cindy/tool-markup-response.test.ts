import { expect, it } from 'vitest';
import { ToolMarkupResponseTransform } from './tool-markup-response.js';

// #6531 unit: native Responses bypasses Chat translation. Real Transform input/output
// must keep tool IDs/input and strip serialized text in both streaming/final payloads.
async function transform(events: unknown[]): Promise<Array<Record<string, unknown>>> {
  const t = new ToolMarkupResponseTransform();
  let wire = '';
  t.on('data', chunk => { wire += chunk.toString(); });
  const ended = new Promise<void>((resolve, reject) => { t.on('end', resolve); t.on('error', reject); });
  t.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  await ended;
  return wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
}
it.each(['response.output_text.delta', 'response.reasoning_summary_text.delta'])(
  'deduplicates native %s and keeps structured custom input', async type => {
    const input = 'text("ok")';
    const markup = '<tool_call><function=exec>' + input + '</tool_call>';
    const events = await transform([
      { type, item_id: 'msg1', content_index: 0, delta: 'before.' + markup.slice(0, 15), sequence_number: 0 },
      { type, item_id: 'msg1', content_index: 0, delta: markup.slice(15), sequence_number: 1 },
      { type: 'response.output_item.done', item: { type: 'custom_tool_call', id: 'ctc1', call_id: 'call1', name: 'exec', input }, sequence_number: 2 },
      { type: 'response.completed', response: { output: [{ type: 'message', id: 'msg1', content: [{ type: 'output_text', text: 'before.' + markup }] }] }, sequence_number: 3 },
    ]);
    expect(JSON.stringify(events)).not.toContain('<tool_call>');
    expect(events).toContainEqual(expect.objectContaining({ type: 'response.output_item.done', item: expect.objectContaining({ id: 'ctc1', call_id: 'call1', input }) }));
    expect(events.filter(e => typeof e.sequence_number === 'number').map(e => e.sequence_number)).toEqual(events.map((_, i) => i));
    expect(events.at(-1)).toMatchObject({ type: 'response.completed' });
  },
);
it('fails final-only native markup instead of showing it or silently succeeding', async () => {
  const item = { type: 'message', id: 'msg', content: [{ type: 'output_text', text: '<invoke name="Read"><parameter name="path" string="true">a</parameter></invoke>' }] };
  const events = await transform([
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { output: [item] } },
  ]);
  expect(JSON.stringify(events)).not.toContain('<invoke');
  expect(events.at(-1)).toMatchObject({ type: 'response.failed', response: { error: { code: 'unexecuted-tool-markup' } } });
});
it('preserves opaque reasoning, tool input and truncated diagnostics', async () => {
  const input = '<tool_call>{"name":"read","arguments":{}}</tool_call>';
  const events = await transform([
    { type: 'response.output_item.done', item: { id: 'r', type: 'reasoning', encrypted_content: input } },
    { type: 'response.output_item.done', item: { id: 'c', call_id: 'c', type: 'custom_tool_call', name: 'exec', input } },
    { type: 'response.incomplete', response: { output: [] } },
  ]);
  expect(events[0]).toMatchObject({ item: { encrypted_content: input } });
  expect(events[1]).toMatchObject({ item: { input } });
  expect(events.at(-1)).toMatchObject({ type: 'response.incomplete' });
});

it('keeps citation offsets and the original upstream error authoritative', async () => {
  const markup = '<tool_call>{"name":"read","arguments":{}}</tool_call>';
  const cited = { type: 'message', id: 'm', content: [{ type: 'output_text', text: markup, annotations: [{ type: 'url_citation', start_index: 0, end_index: 5, url: 'https://example.invalid' }] }] };
  const events = await transform([
    { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: markup },
    { type: 'response.output_item.done', item: cited },
    { type: 'response.completed', response: { output: [cited] } },
  ]);
  expect(events.at(-1)).toMatchObject({ type: 'response.completed', response: { output: [cited] } });
  expect(events.filter(e => e.type === 'response.output_text.delta').map(e => e.delta).join('')).toBe(markup);
  const failed = await transform([
    { type: 'response.output_text.delta', delta: markup },
    { type: 'error', code: 'upstream_failure', message: 'original error' },
  ]);
  expect(failed.map(e => e.type)).toEqual(['response.output_text.delta', 'error']);
  expect(failed.at(-1)).toMatchObject({ code: 'upstream_failure', message: 'original error' });
});
