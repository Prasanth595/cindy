import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCodexImageChannel } from '../codexImageClient.js';

const image = 'iVBORw0KGgo=';
const params = { model: 'openai/gpt-image-2', prompt: 'a blue circle' };
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});
function response(body: unknown = { data: [{ b64_json: image }], size: '1254x1254' }) {
  return Response.json(body);
}
function channel(
  fetchImplementation: typeof fetch,
  overrides: Partial<Parameters<typeof createCodexImageChannel>[0]> = {},
) {
  return createCodexImageChannel({
    hasOAuthLogin: () => true,
    getAuth: async () => ({ accessToken: 'test-token', accountId: 'test-account' }),
    fetchImplementation,
    ...overrides,
  });
}

describe('Codex standalone Images API', () => {
  it('generates with the image model, without a Responses host or hosted tool', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const result = await channel(fetch).generateImage({
      ...params,
      size: '1024x1024',
      quality: 'low',
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://chatgpt.com/backend-api/codex/images/generations');
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'gpt-image-2',
      prompt: params.prompt,
      size: '1024x1024',
      quality: 'low',
      background: 'opaque',
    });
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer test-token',
      'ChatGPT-Account-Id': 'test-account',
      Accept: 'application/json',
    });
    expect(init?.headers).not.toHaveProperty('OpenAI-Beta');
    expect(result.data).toEqual([{ b64_json: image }]);
    // Preserve the returned bytes; requested size is not authoritative output metadata.
    expect(result).not.toHaveProperty('size');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('edits using JSON images with sniffed MIME, not Responses input or multipart', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-image-edit-'));
    directories.push(dir);
    const png = path.join(dir, 'reference.dat');
    const jpeg = path.join(dir, 'other.dat');
    await fs.writeFile(png, Buffer.from(image, 'base64'));
    await fs.writeFile(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    await channel(fetch).editImage({ ...params, imagePaths: [png, jpeg], aspectRatio: '3:2' });
    expect(fetch.mock.calls[0]?.[0]).toBe('https://chatgpt.com/backend-api/codex/images/edits');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      model: 'gpt-image-2',
      prompt: params.prompt,
      background: 'opaque',
      size: '1536x1024',
      images: [
        { image_url: 'data:image/png;base64,' + image },
        { image_url: 'data:image/jpeg;base64,/9j/4A==' },
      ],
    });
    await expect(channel(fetch).editImage({ ...params, imagePaths: [] })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps compatibility handles local and respects selected account credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const beforeDispatch = vi.fn();
    const c = channel(fetch, { providerId: 'openai-account-a', beforeDispatch });
    await c.generateImage({ ...params, model: 'openai-account-a/future-image' });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).model).toBe('gpt-image-2');
    expect(beforeDispatch).toHaveBeenCalledWith('openai-account-a/future-image');
    await expect(c.generateImage(params)).rejects.toThrow('不支持模型');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves explicit options and leaves unspecified options omitted', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    await channel(fetch).generateImage({
      ...params,
      model: 'openai/gpt-image-2.5-sunburst',
      size: '1760x3824',
      quality: 'max',
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      size: '1760x3824',
      quality: 'max',
    });
    await channel(fetch).generateImage(params);
    const body = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body));
    expect(body).not.toHaveProperty('size');
    expect(body).not.toHaveProperty('quality');
    await expect(channel(fetch).generateImage({ ...params, size: '1320x2868' })).rejects.toThrow(
      'divisible by 16',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not dispatch if the selected account changes during preparation', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const getAuth = vi
      .fn()
      .mockResolvedValueOnce({ accessToken: 'old', accountId: 'a' })
      .mockResolvedValueOnce({ accessToken: 'new', accountId: 'b' });
    await expect(channel(fetch, { getAuth }).generateImage(params)).rejects.toThrow(
      'account changed',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks model availability again immediately before dispatch', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const beforeDispatch = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('disabled');
      });
    await expect(channel(fetch, { beforeDispatch }).generateImage(params)).rejects.toThrow(
      'disabled',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 429, 500])(
    'preserves HTTP %s without retrying or switching providers',
    async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>(async () =>
        Response.json({ error: { message: 'upstream failure' } }, { status }),
      );
      const onAuthFailure = vi.fn(async () => {
        throw new Error('coordinator failed');
      });
      await expect(channel(fetch, { onAuthFailure }).generateImage(params)).rejects.toThrow(
        'HTTP ' + status,
      );
      expect(onAuthFailure).toHaveBeenCalledWith({
        status,
        body: JSON.stringify({ error: { message: 'upstream failure' } }),
        failedAccessToken: 'test-token',
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    null,
    {},
    { data: [] },
    { data: [{}] },
    { data: [{ b64_json: '' }] },
    { data: [{ b64_json: 123 }] },
    { partial_image_b64: image },
  ])('rejects incomplete result %j', async (body) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(body));
    await expect(channel(fetch).generateImage(params)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects truncated JSON and network failures without resubmission', async () => {
    for (const impl of [
      async () => new Response('{"data":['),
      async () => {
        throw new Error('network interrupted');
      },
    ]) {
      const fetch = vi.fn<typeof globalThis.fetch>(impl);
      await expect(channel(fetch).generateImage(params)).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it('forwards cancellation and does not submit an already cancelled request', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const c = channel(fetch);
    await expect(c.generateImage({ ...params, signal: controller.signal })).rejects.toThrow();
    await expect(c.generateImage({ ...params, signal: controller.signal })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps readiness and missing credentials within the existing auth boundary', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const c = channel(fetch, {
      hasOAuthLogin: () => false,
      getAuth: async () => {
        throw new Error('login required');
      },
    });
    expect(c.ready()).toBe(false);
    await expect(c.generateImage(params)).rejects.toThrow('login required');
    expect(fetch).not.toHaveBeenCalled();
  });
});
