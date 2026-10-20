import { Transform, type TransformCallback } from 'node:stream';
import { SerializedToolCallEcho, reconcileToolCallMarkup, scanToolCallMarkup,
  UNEXECUTED_TOOL_MARKUP_MESSAGE, UNEXECUTED_TOOL_MARKUP_REASON,
  type StructuredToolCall } from './tool-call-markup.js';
type Obj = Record<string, unknown>;
function obj(value: unknown): value is Obj { return !!value && typeof value === 'object' && !Array.isArray(value); }
/** Request-scoped Responses SSE projection. IDs, tools, usage and opaque reasoning stay intact. */
export class ToolMarkupResponseTransform extends Transform {
  private decoder = new TextDecoder();
  private pending = '';
  private streams = new Map<string, { buffer: SerializedToolCallEcho; event: Obj }>();
  private calls = new Map<string, StructuredToolCall>();
  private deferred: Obj[] = [];
  private deferredBytes = 0;
  private sequence = 0;
  private unexecuted = false;
  private terminal = false;
  private passthrough = false;
  private preserveText = false;
  private collect(item: unknown): void {
    if (!obj(item) || this.calls.size >= 128 || typeof item.name !== 'string') return;
    if (item.type === 'custom_tool_call' && typeof item.input === 'string') {
      this.calls.set(String(item.call_id ?? item.id), { name: item.name, input: item.input });
    } else if (item.type === 'function_call' && typeof item.arguments === 'string') {
      this.calls.set(String(item.call_id ?? item.id), { name: item.name, arguments: item.arguments });
    }
  }
  private cleanText(text: unknown): unknown {
    if (typeof text !== 'string' || this.preserveText) return text;
    const result = reconcileToolCallMarkup(text, [...this.calls.values()], true);
    this.unexecuted ||= result.unexecuted;
    return result.text;
  }
  private cleanItem(item: unknown): unknown {
    if (!obj(item)) return item;
    if (item.type === 'message' && Array.isArray(item.content)) return { ...item, content: item.content.map(part =>
      obj(part) && part.type === 'output_text' ? { ...part, text: this.cleanText(part.text) } : part) };
    if (item.type === 'reasoning' && Array.isArray(item.summary)) return { ...item, summary: item.summary.map(part =>
      obj(part) && part.type === 'summary_text' ? { ...part, text: this.cleanText(part.text) } : part) };
    return item;
  }
  private cleanEvent(event: Obj): Obj {
    if (event.type === 'response.output_item.done') return { ...event, item: this.cleanItem(event.item) };
    if ((event.type === 'response.output_text.done' || event.type === 'response.reasoning_summary_text.done') && typeof event.text === 'string') {
      return { ...event, text: this.cleanText(event.text) };
    }
    if ((event.type === 'response.content_part.done' || event.type === 'response.reasoning_summary_part.done') && obj(event.part)) {
      return { ...event, part: { ...event.part, text: this.cleanText(event.part.text) } };
    }
    return event;
  }
  private writeEvent(event: Obj): void {
    const wire = typeof event.sequence_number === 'number' ? { ...event, sequence_number: this.sequence++ } : event;
    this.push('event: ' + String(wire.type) + '\ndata: ' + JSON.stringify(wire) + '\n\n');
  }
  private finishHeld(preserve = false): void {
    preserve ||= this.preserveText;
    for (const stream of this.streams.values()) {
      const result = preserve ? { text: stream.buffer.drain(), unexecuted: false }
        : stream.buffer.resolveReport([...this.calls.values()], true);
      this.unexecuted ||= result.unexecuted;
      if (result.text) this.writeEvent({ ...stream.event, delta: result.text });
    }
    this.streams.clear();
    for (const event of this.deferred) this.writeEvent(preserve ? event : this.cleanEvent(event));
    this.deferred = []; this.deferredBytes = 0;
  }
  private frame(frame: string): void {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    let event: unknown;
    try { event = JSON.parse(data); } catch { this.push(frame + '\n\n'); return; }
    if (!obj(event) || this.terminal || this.passthrough) { this.push(frame + '\n\n'); return; }
    if (event.type === 'response.output_item.done') this.collect(event.item);
    if (obj(event.response) && Array.isArray(event.response.output)) for (const item of event.response.output) this.collect(item);
    // Citation offsets refer to the original text. Keep that response byte-for-byte
    // in text fields rather than deleting a span without remapping its annotations.
    const items = [event.item, ...(obj(event.response) && Array.isArray(event.response.output) ? event.response.output : [])];
    if (event.type === 'response.output_text.annotation.added'
      || (obj(event.part) && Array.isArray(event.part.annotations) && event.part.annotations.length > 0)
      || items.some(item => obj(item) && Array.isArray(item.content) && item.content.some(part =>
        obj(part) && Array.isArray(part.annotations) && part.annotations.length > 0))) this.preserveText = true;
    if (event.type === 'error') {
      this.finishHeld(true);
      this.writeEvent(event);
      this.terminal = true;
      return;
    }
    if (event.type === 'response.output_text.delta' || event.type === 'response.reasoning_summary_text.delta') {
      if (typeof event.delta !== 'string') { this.writeEvent(event); return; }
      const key = JSON.stringify([event.type, event.item_id, event.content_index ?? event.summary_index]);
      let stream = this.streams.get(key);
      if (!stream && this.streams.size >= 128) { this.finishHeld(true); this.passthrough = true; this.writeEvent(event); return; }
      if (!stream) { stream = { buffer: new SerializedToolCallEcho(), event }; this.streams.set(key, stream); }
      stream.event = event;
      const visible = stream.buffer.push(event.delta);
      if (visible) this.writeEvent({ ...event, delta: visible });
      return;
    }
    if (event.type === 'response.completed' || event.type === 'response.failed' || event.type === 'response.incomplete') {
      const preserve = event.type !== 'response.completed';
      this.finishHeld(preserve);
      const response = obj(event.response) ? event.response : {};
      const output = !preserve && Array.isArray(response.output) ? response.output.map(item => this.cleanItem(item)) : response.output;
      const failed = !preserve && this.unexecuted;
      this.writeEvent({ ...event, type: failed ? 'response.failed' : event.type,
        response: { ...response, ...(output ? { output } : {}), ...(failed ? { status: 'failed',
          error: { code: UNEXECUTED_TOOL_MARKUP_REASON, message: UNEXECUTED_TOOL_MARKUP_MESSAGE } } : {}) } });
      this.terminal = true;
      return;
    }
    const serialized = JSON.stringify(event);
    const item = obj(event.item) ? event.item : {};
    const parts = Array.isArray(item.content) ? item.content : Array.isArray(item.summary) ? item.summary : [];
    const texts = [event.text, obj(event.part) ? event.part.text : undefined, ...parts.map(part => obj(part) ? part.text : undefined)];
    const done = String(event.type).endsWith('.done');
    const pending = [...this.streams.values()].some(stream => stream.buffer.hasPending);
    if (done && (pending || texts.some(text => typeof text === 'string' && scanToolCallMarkup(text).length > 0))) {
      this.deferred.push(event); this.deferredBytes += serialized.length;
      if (this.deferredBytes > 256 * 1024) { this.finishHeld(true); this.passthrough = true; }
      return;
    }
    this.writeEvent(event);
  }
  private drainFrames(): void {
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match) break;
      const frame = this.pending.slice(0, match.index);
      this.pending = this.pending.slice(match.index + match[0].length);
      this.frame(frame);
    }
  }
  override _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    this.drainFrames();
    if (this.pending.length > 1024 * 1024) { this.finishHeld(true); this.push(this.pending); this.pending = ''; this.passthrough = true; }
    callback();
  }
  override _flush(callback: TransformCallback): void {
    this.pending += this.decoder.decode(); this.drainFrames();
    this.finishHeld(true);
    if (this.pending) this.push(this.pending);
    callback();
  }
}
export function createToolMarkupResponseTransform(response: { contentType: string; contentEncoding: string }): Transform | null {
  return response.contentType.toLowerCase().startsWith('text/event-stream') && (!response.contentEncoding || response.contentEncoding === 'identity')
    ? new ToolMarkupResponseTransform() : null;
}
