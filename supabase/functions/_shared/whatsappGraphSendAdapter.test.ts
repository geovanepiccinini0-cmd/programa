import { describe, expect, test, vi } from 'vitest';
import { sendWhatsappTextMessage, type FetchLikeResponse } from './whatsappGraphSendAdapter.ts';

const BASE_INPUT = {
  accessToken: 'fake-token-never-real',
  phoneNumberId: 'phone-number-id-A',
  toE164: '+5551900000001',
  body: 'Ola, tudo bem?',
};

function makeDeps(fetchFn: (url: string, init: unknown) => Promise<FetchLikeResponse>) {
  return {
    fetchFn: fetchFn as never,
    timeoutMs: 5000,
    createAbortController: () => new AbortController(),
  };
}

function jsonResponse(status: number, body: unknown): FetchLikeResponse {
  return { status, text: async () => JSON.stringify(body) };
}

describe('sendWhatsappTextMessage', () => {
  test('HTTP 2xx com wamid valido -> ACCEPTED, nunca inclui token/telefone/conteudo no resultado', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { messages: [{ id: 'wamid.ABC123' }] }));
    const result = await sendWhatsappTextMessage(BASE_INPUT, makeDeps(fetchFn));
    expect(result).toEqual({ outcome: 'ACCEPTED', externalMessageId: 'wamid.ABC123' });
    expect(JSON.stringify(result)).not.toContain(BASE_INPUT.accessToken);
    expect(JSON.stringify(result)).not.toContain(BASE_INPUT.toE164);
    expect(JSON.stringify(result)).not.toContain(BASE_INPUT.body);
  });

  test('HTTP 2xx SEM wamid valido -> UNCERTAIN, nunca ACCEPTED', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(200, { messages: [] }));
    const result = await sendWhatsappTextMessage(BASE_INPUT, makeDeps(fetchFn));
    expect(result.outcome).toBe('UNCERTAIN');
  });

  test('HTTP 2xx com corpo nao-JSON -> UNCERTAIN', async () => {
    const fetchFn = vi.fn(async () => ({ status: 200, text: async () => 'not json' }));
    const result = await sendWhatsappTextMessage(BASE_INPUT, makeDeps(fetchFn));
    expect(result.outcome).toBe('UNCERTAIN');
  });

  test('HTTP 400 com corpo de erro estruturado da Meta -> REJECTED_DEFINITIVE', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(400, { error: { code: 131026, message: 'Recipient number not valid' } }));
    const result = await sendWhatsappTextMessage(BASE_INPUT, makeDeps(fetchFn));
    expect(result).toEqual({ outcome: 'REJECTED_DEFINITIVE', errorCode: '131026', httpStatus: 400 });
  });

  test('HTTP 400 SEM corpo de erro estruturado -> UNCERTAIN, nunca presumido como rejeicao', async () => {
    const fetchFn = vi.fn(async () => ({ status: 400, text: async () => '' }));
    const result = await sendWhatsappTextMessage(BASE_INPUT, makeDeps(fetchFn));
    expect(result.outcome).toBe('UNCERTAIN');
  });

  test('HTTP 5xx -> UNCERTAIN, nunca presumido como falha definitiva', async () => {
    const fetchFn = vi.fn(async () => ({ status: 500, text: async () => 'internal error' }));
    const result = await sendWhatsappTextMessage(BASE_INPUT, makeDeps(fetchFn));
    expect(result).toEqual({ outcome: 'UNCERTAIN', reason: 'unclassified_http_status_500', httpStatus: 500 });
  });

  test('HTTP 503 -> UNCERTAIN', async () => {
    const fetchFn = vi.fn(async () => ({ status: 503, text: async () => '' }));
    const result = await sendWhatsappTextMessage(BASE_INPUT, makeDeps(fetchFn));
    expect(result.outcome).toBe('UNCERTAIN');
  });

  test('HTTP 401 (token invalido/expirado) -> UNCERTAIN, nunca rejeicao da MENSAGEM', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(401, { error: { code: 190, message: 'Invalid OAuth access token' } }));
    const result = await sendWhatsappTextMessage(BASE_INPUT, makeDeps(fetchFn));
    expect(result.outcome).toBe('UNCERTAIN');
  });

  test('HTTP 429 (rate limit da Meta) -> UNCERTAIN, nunca rejeicao de conteudo', async () => {
    const fetchFn = vi.fn(async () => jsonResponse(429, { error: { code: 80007, message: 'Rate limit hit' } }));
    const result = await sendWhatsappTextMessage(BASE_INPUT, makeDeps(fetchFn));
    expect(result.outcome).toBe('UNCERTAIN');
  });

  test('timeout (AbortError) -> UNCERTAIN com reason=timeout, nunca presumido como aceite ou falha', async () => {
    const fetchFn = vi.fn(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const result = await sendWhatsappTextMessage(BASE_INPUT, makeDeps(fetchFn));
    expect(result).toEqual({ outcome: 'UNCERTAIN', reason: 'timeout', httpStatus: null });
  });

  test('erro de rede generico -> UNCERTAIN com reason=network_error', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('ECONNRESET'); });
    const result = await sendWhatsappTextMessage(BASE_INPUT, makeDeps(fetchFn));
    expect(result).toEqual({ outcome: 'UNCERTAIN', reason: 'network_error', httpStatus: null });
  });

  test('nunca loga/inclui o accessToken em nenhum caminho de resultado (todas as classificacoes)', async () => {
    const scenarios = [
      jsonResponse(200, { messages: [{ id: 'wamid.X' }] }),
      jsonResponse(400, { error: { code: 1, message: 'x' } }),
      { status: 500, text: async () => 'err' } as FetchLikeResponse,
    ];
    for (const response of scenarios) {
      const fetchFn = vi.fn(async () => response);
      const result = await sendWhatsappTextMessage(BASE_INPUT, makeDeps(fetchFn));
      expect(JSON.stringify(result)).not.toContain(BASE_INPUT.accessToken);
    }
  });

  test('envia o Authorization Bearer e o payload correto para a URL da Graph API', async () => {
    let capturedUrl = '';
    let capturedInit: Record<string, unknown> = {};
    const fetchFn = vi.fn(async (url: string, init: Record<string, unknown>) => {
      capturedUrl = url;
      capturedInit = init;
      return jsonResponse(200, { messages: [{ id: 'wamid.X' }] });
    });
    await sendWhatsappTextMessage(BASE_INPUT, makeDeps(fetchFn));
    expect(capturedUrl).toContain(BASE_INPUT.phoneNumberId);
    expect((capturedInit.headers as Record<string, string>).Authorization).toBe(`Bearer ${BASE_INPUT.accessToken}`);
    const parsedBody = JSON.parse(capturedInit.body as string);
    expect(parsedBody).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: BASE_INPUT.toE164,
      type: 'text',
      text: { body: BASE_INPUT.body },
    });
  });

  test('input invalido (accessToken vazio) -> lanca antes de qualquer fetch', async () => {
    const fetchFn = vi.fn();
    await expect(sendWhatsappTextMessage({ ...BASE_INPUT, accessToken: '' }, makeDeps(fetchFn))).rejects.toThrow(TypeError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
