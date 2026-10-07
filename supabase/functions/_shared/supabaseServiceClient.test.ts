import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createSupabaseServiceClient } from './supabaseServiceClient.ts';

const FAKE_SECRET = 'TEST_SERVICE_ROLE_SECRET_DO_NOT_LEAK';
const FAKE_URL = 'https://fake-project.supabase.co';
const VALID_CONFIG = { url: FAKE_URL, serviceRoleKey: FAKE_SECRET };

const EXPECTED_OPTIONS = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
};

describe('createSupabaseServiceClient', () => {
  // 1. createClientFn chamado uma unica vez
  test('chama createClientFn exatamente uma vez', () => {
    const fakeClient = { marker: 'fake-client' };
    const createClientFn = vi.fn(() => fakeClient);
    createSupabaseServiceClient(VALID_CONFIG, createClientFn);
    expect(createClientFn).toHaveBeenCalledTimes(1);
  });

  // 2 + 3. URL e serviceRoleKey exatos
  test('chama createClientFn com url e serviceRoleKey exatos', () => {
    const createClientFn = vi.fn(() => ({}));
    createSupabaseServiceClient(VALID_CONFIG, createClientFn);
    expect(createClientFn).toHaveBeenCalledWith(FAKE_URL, FAKE_SECRET, expect.anything());
  });

  // 4. options exatamente auth: {persistSession:false, autoRefreshToken:false, detectSessionInUrl:false}
  test('chama createClientFn com as auth options exatas', () => {
    const createClientFn = vi.fn(() => ({}));
    createSupabaseServiceClient(VALID_CONFIG, createClientFn);
    const [, , options] = createClientFn.mock.calls[0];
    expect(options).toEqual(EXPECTED_OPTIONS);
  });

  // 5. retorno passthrough
  test('retorna exatamente o objeto devolvido por createClientFn', () => {
    const fakeClient = { marker: 'fake-client-passthrough' };
    const createClientFn = vi.fn(() => fakeClient);
    const result = createSupabaseServiceClient(VALID_CONFIG, createClientFn);
    expect(result).toBe(fakeClient);
  });

  // 6. createClientFn throw propaga (incluindo quando a exception carrega a secret fake)
  test('propaga exception lancada por createClientFn, sem converter para REPOSITORY_ERROR', () => {
    const boom = new Error(`falha simulada contendo ${FAKE_SECRET}`);
    const createClientFn = vi.fn(() => {
      throw boom;
    });
    expect(() => createSupabaseServiceClient(VALID_CONFIG, createClientFn)).toThrow(boom);
  });

  // 7. config nao e mutado
  test('nao muta o objeto config recebido', () => {
    const config = Object.freeze({ url: FAKE_URL, serviceRoleKey: FAKE_SECRET });
    const createClientFn = vi.fn(() => ({}));
    expect(() => createSupabaseServiceClient(config, createClientFn)).not.toThrow();
  });

  // 8. config ausente falha
  test('lanca quando config esta ausente/nao e objeto', () => {
    const createClientFn = vi.fn(() => ({}));
    // @ts-expect-error -- teste deliberado de input invalido
    expect(() => createSupabaseServiceClient(undefined, createClientFn)).toThrow(TypeError);
    // @ts-expect-error -- teste deliberado de input invalido
    expect(() => createSupabaseServiceClient(null, createClientFn)).toThrow(TypeError);
    // @ts-expect-error -- teste deliberado de input invalido
    expect(() => createSupabaseServiceClient('nao e objeto', createClientFn)).toThrow(TypeError);
    expect(createClientFn).not.toHaveBeenCalled();
  });

  // 9. url ausente falha
  test('lanca quando config.url esta ausente', () => {
    const createClientFn = vi.fn(() => ({}));
    // @ts-expect-error -- teste deliberado de input invalido
    expect(() => createSupabaseServiceClient({ serviceRoleKey: FAKE_SECRET }, createClientFn)).toThrow(/url/);
    expect(createClientFn).not.toHaveBeenCalled();
  });

  // 10. url vazia falha
  test('lanca quando config.url esta vazia', () => {
    const createClientFn = vi.fn(() => ({}));
    expect(() => createSupabaseServiceClient({ url: '', serviceRoleKey: FAKE_SECRET }, createClientFn)).toThrow(/url/);
    expect(createClientFn).not.toHaveBeenCalled();
  });

  // 11. url whitespace falha
  test('lanca quando config.url e whitespace-only', () => {
    const createClientFn = vi.fn(() => ({}));
    expect(() => createSupabaseServiceClient({ url: '   ', serviceRoleKey: FAKE_SECRET }, createClientFn)).toThrow(/url/);
    expect(createClientFn).not.toHaveBeenCalled();
  });

  // 12. serviceRoleKey ausente falha
  test('lanca quando config.serviceRoleKey esta ausente', () => {
    const createClientFn = vi.fn(() => ({}));
    // @ts-expect-error -- teste deliberado de input invalido
    expect(() => createSupabaseServiceClient({ url: FAKE_URL }, createClientFn)).toThrow(/serviceRoleKey/);
    expect(createClientFn).not.toHaveBeenCalled();
  });

  // 13. serviceRoleKey vazia falha
  test('lanca quando config.serviceRoleKey esta vazia', () => {
    const createClientFn = vi.fn(() => ({}));
    expect(() => createSupabaseServiceClient({ url: FAKE_URL, serviceRoleKey: '' }, createClientFn)).toThrow(/serviceRoleKey/);
    expect(createClientFn).not.toHaveBeenCalled();
  });

  // 14. serviceRoleKey whitespace falha
  test('lanca quando config.serviceRoleKey e whitespace-only', () => {
    const createClientFn = vi.fn(() => ({}));
    expect(() => createSupabaseServiceClient({ url: FAKE_URL, serviceRoleKey: '  \t' }, createClientFn)).toThrow(/serviceRoleKey/);
    expect(createClientFn).not.toHaveBeenCalled();
  });

  // 15. createClientFn nao-function falha
  test('lanca quando createClientFn nao e uma function', () => {
    // @ts-expect-error -- teste deliberado de input invalido
    expect(() => createSupabaseServiceClient(VALID_CONFIG, 'nao e funcao')).toThrow(TypeError);
    // @ts-expect-error -- teste deliberado de input invalido
    expect(() => createSupabaseServiceClient(VALID_CONFIG, undefined)).toThrow(TypeError);
  });

  // 16. nenhuma criacao parcial em input invalido
  test('nunca chama createClientFn quando a validacao de config falha', () => {
    const createClientFn = vi.fn(() => ({ marker: 'nao deveria existir' }));
    expect(() => createSupabaseServiceClient({ url: '', serviceRoleKey: '' }, createClientFn)).toThrow();
    expect(createClientFn).not.toHaveBeenCalled();
  });

  // Fase 3.2.3.1B — fecha o gap encontrado na auditoria 3.2.3.1A (MEDIUM):
  // o objeto options (e o objeto auth interno) devem ter identidade NOVA
  // em cada chamada, nunca uma referencia compartilhada/module-level.
  // Mutar o objeto capturado de uma chamada nunca pode vazar para outra.
  test('options e options.auth tem identidade nova por chamada; mutar uma nao afeta a outra', () => {
    let optionsA;
    let optionsB;
    const createClientFnA = vi.fn((_url, _key, options) => {
      optionsA = options;
      return {};
    });
    const createClientFnB = vi.fn((_url, _key, options) => {
      optionsB = options;
      return {};
    });

    createSupabaseServiceClient(VALID_CONFIG, createClientFnA);
    createSupabaseServiceClient(VALID_CONFIG, createClientFnB);

    expect(optionsA).not.toBe(optionsB);
    expect(optionsA.auth).not.toBe(optionsB.auth);

    // mutar A nao pode afetar B
    optionsA.auth.persistSession = true;
    expect(optionsB.auth.persistSession).toBe(false);

    // reverse-order isolation: mutar B (agora) nao pode reverter/afetar o A ja mutado
    optionsB.auth.persistSession = true;
    expect(optionsA.auth.persistSession).toBe(true);
  });

  // 17. zero cache/singleton observavel
  test('nao mantem nenhum client em cache/singleton entre chamadas', () => {
    const clientA = { id: 'a' };
    const clientB = { id: 'b' };
    const createClientFnA = vi.fn(() => clientA);
    const createClientFnB = vi.fn(() => clientB);

    const resultA = createSupabaseServiceClient(VALID_CONFIG, createClientFnA);
    const resultB = createSupabaseServiceClient(VALID_CONFIG, createClientFnB);

    expect(resultA).toBe(clientA);
    expect(resultB).toBe(clientB);
    expect(resultA).not.toBe(resultB);
  });

  // 18. chamadas distintas podem produzir clients distintos
  test('chamadas distintas com createClientFn distintas produzem resultados distintos', () => {
    let counter = 0;
    const createClientFn = vi.fn(() => ({ instanceId: counter++ }));

    const first = createSupabaseServiceClient(VALID_CONFIG, createClientFn);
    const second = createSupabaseServiceClient(VALID_CONFIG, createClientFn);

    expect(first).not.toBe(second);
    expect(first.instanceId).toBe(0);
    expect(second.instanceId).toBe(1);
  });

  // 19. mensagens de validacao propria nunca contem a fake secret
  test('mensagens de validacao propria nunca contem a secret fake', () => {
    const createClientFn = vi.fn(() => ({}));
    try {
      createSupabaseServiceClient({ url: FAKE_URL, serviceRoleKey: '' }, createClientFn);
      throw new Error('deveria ter lancado');
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).not.toContain(FAKE_SECRET);
    }
  });

  test('fronteira documentada: exception externa de createClientFn e propagada como recebida, mesmo contendo a secret fake', () => {
    // Este teste documenta deliberadamente a fronteira descrita na Fase
    // 3.2.3.1, secao 13: NAO alteramos/redigimos artificialmente uma
    // exception lancada por uma dependencia externa (createClientFn).
    // Nossas PROPRIAS mensagens (validacao de config) nunca contem
    // secret — isso e garantido pelo teste anterior. Uma exception
    // EXTERNA e fora do nosso controle e e propagada verbatim.
    const externalBoom = new Error(`erro externo simulado: ${FAKE_SECRET}`);
    const createClientFn = vi.fn(() => {
      throw externalBoom;
    });
    expect(() => createSupabaseServiceClient(VALID_CONFIG, createClientFn)).toThrowError(externalBoom);
  });

  describe('auditoria estatica de seguranca (supabaseServiceClient.ts)', () => {
    const source = readFileSync(new URL('./supabaseServiceClient.ts', import.meta.url), 'utf8');
    const codeLines = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    const forbiddenPatterns: Array<[string, RegExp]> = [
      ['Deno.env', /Deno\.env/],
      ['npm: specifier', /npm:/],
      ['import.meta.env', /import\.meta\.env/],
      ['VITE_', /VITE_/],
      ['SUPABASE_ANON_KEY', /SUPABASE_ANON_KEY/],
      ['DEFAULT_SERVICE', /DEFAULT_SERVICE/],
      ['DEFAULT_URL', /DEFAULT_URL/],
      ['import real de createClient', /from\s+['"]@supabase\/supabase-js/],
      ['src/lib/supabaseClient', /src\/lib\/supabaseClient/],
      ['console.log', /console\.log/],
      ['console.error', /console\.error/],
      ['fetch(', /fetch\(/],
      ['XMLHttpRequest', /XMLHttpRequest/],
      ['localStorage', /localStorage/],
    ];

    test.each(forbiddenPatterns)('codigo real nao contem: %s', (_label, pattern) => {
      expect(codeLines).not.toMatch(pattern);
    });
  });
});
