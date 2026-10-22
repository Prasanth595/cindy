import type { SpeechAdapter } from './types.js';

export const openaiSpeechAdapter: SpeechAdapter = {
  contentTypes: ['audio/pcm', 'audio/x-pcm', 'application/octet-stream'],
  request(prefix, input) {
    return {
      url: new URL(`${prefix}/audio/speech`),
      body: JSON.stringify({
        model: input.modelId,
        voice: input.voice,
        input: input.text,
        response_format: 'pcm',
        ...(input.speed !== undefined ? { speed: input.speed } : {}),
      }),
    };
  },
  pcm: (body) => body,
};
