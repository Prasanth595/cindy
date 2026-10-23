import type { SpeechProtocol } from '../../../shared/speechProtocols.js';

export type SpeechConnection = {
  baseUrl: string;
  headers: Record<string, string>;
  protocol: SpeechProtocol;
};
export type SpeechInput = { modelId: string; voice: string; text: string; speed?: number };
export type SpeechRequest = { url: URL; body: string; headers?: Record<string, string> };

/** Every adapter produces pull-driven 24 kHz, 16-bit LE mono PCM. A successful
 * EOF means synthesis completed; cancellation must cancel the provider reader. */
export type SpeechAdapter = {
  contentTypes: readonly string[];
  request(prefix: string, input: SpeechInput): SpeechRequest;
  pcm(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array>;
};
