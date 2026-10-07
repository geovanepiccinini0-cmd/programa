import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { readSupabaseServiceConfig } from './supabaseServiceConfig.ts';

const FAKE_SECRET = 'TEST_SERVICE_ROLE_SECRET_DO_NOT_LEAK';
const FAKE_URL = 'https://fake-project.supabase.co';

function makeEnvReader(values: Record<string, string | undefined>) {
  return vi.fn((key: string) => values[key]);
}

describe('readSupabaseServiceConfig', () => {
  // 1. URL ausente
  test('lanca quando SUPABASE_URL esta ausente', () => {
    const envReader = makeEnvReader({ SUPABASE_SERVICE_ROLE_KEY: FAKE_SECRET });
    expect(() => readSupabaseServiceConfig(envReader)).toThrow(/SUPABASE_URL/);
  });

  // 2. URL vazia
  test('lanca quando SUPABASE_URL esta vazia', () => {
    const envReader = makeEnvReader({ SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: FAKE_SECRET });
    expect(() => readSupabaseServiceConfig(envReader)).toThrow(/SUPABASE_URL/);
  });

  // 3. URL whitespace
  test('lanca quando SUPABASE_URL e whitespace-only', () => {
    const envReader = makeEnvReader({ SUPABASE_URL: '   \t  ', SUPABASE_SERVICE_ROLE_KEY: FAKE_SECRET });
    expect(() => readSupabaseServiceConfig(envReader)).toThrow(/SUPABASE_URL/);
  });

  // 4. service role ausente
  test('lanca quando SUPABASE_SERVICE_ROLE_KEY esta ausente', () => {
    const envReader = makeEnvReader({ SUPABASE_URL: FAKE_URL });
    expect(() => readSupabaseServiceConfig(envReader)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  // 5. service role vazia
  test('lanca quando SUPABASE_SERVICE_ROLE_KEY esta vazia', () => {
    const envReader = makeEnvReader({ SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: '' });
    expect(() => readSupabaseServiceConfig(envReader)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  // 6. service role whitespace
  test('lanca quando SUPABASE_SERVICE_ROLE_KEY e whitespace-only', () => {
    const envReader = makeEnvReader({ SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: '  \n ' });
    expect(() => readSupabaseServiceConfig(envReader)).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  // 7. config valida
  test('retorna config quando ambas as variaveis sao validas', () => {
    const envReader = makeEnvReader({ SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: FAKE_SECRET });
    const config = readSupabaseServiceConfig(envReader);
    expect(config.url).toBe(FAKE_URL);
    expect(config.serviceRoleKey).toBe(FAKE_SECRET);
  });

  // 8. valores preservados exatamente (byte-for-byte, sem trim de valor valido com espacos nas bordas)
  test('preserva valores exatamente, sem trim/normalizacao de um valor valido', () => {
    const urlWithPadding = `  ${FAKE_URL}  `;
    const envReader = makeEnvReader({ SUPABASE_URL: urlWithPadding, SUPABASE_SERVICE_ROLE_KEY: FAKE_SECRET });
    const config = readSupabaseServiceConfig(envReader);
    expect(config.url).toBe(urlWithPadding);
    expect(config.serviceRoleKey).toBe(FAKE_SECRET);
  });

  // 9 + 10. envReader recebe exatamente as duas chaves esperadas
  test('envReader e chamado com SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY', () => {
    const envReader = makeEnvReader({ SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: FAKE_SECRET });
    readSupabaseServiceConfig(envReader);
    expect(envReader).toHaveBeenCalledWith('SUPABASE_URL');
    expect(envReader).toHaveBeenCalledWith('SUPABASE_SERVICE_ROLE_KEY');
  });

  // 11. nenhuma terceira env e consultada
  test('nenhuma terceira variavel de ambiente e consultada', () => {
    const envReader = makeEnvReader({ SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: FAKE_SECRET });
    readSupabaseServiceConfig(envReader);
    expect(envReader).toHaveBeenCalledTimes(2);
    for (const call of envReader.mock.calls) {
      expect(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']).toContain(call[0]);
    }
  });

  // 12. envReader throw propaga
  test('propaga exception lancada pelo envReader, sem transformar em fallback', () => {
    const boom = new Error('boom do envReader');
    const envReader = vi.fn(() => {
      throw boom;
    });
    expect(() => readSupabaseServiceConfig(envReader)).toThrow(boom);
  });

  // 13. input envReader invalido falha fechado
  test('falha fechado quando envReader nao e uma function', () => {
    // @ts-expect-error -- teste deliberado de input invalido
    expect(() => readSupabaseServiceConfig('nao e funcao')).toThrow(TypeError);
    // @ts-expect-error -- teste deliberado de input invalido
    expect(() => readSupabaseServiceConfig(undefined)).toThrow(TypeError);
    // @ts-expect-error -- teste deliberado de input invalido
    expect(() => readSupabaseServiceConfig(null)).toThrow(TypeError);
  });

  // 14. chamadas independentes nao compartilham/mutam estado entre si
  test('chamadas distintas produzem objetos de config independentes', () => {
    const envReaderA = makeEnvReader({ SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: FAKE_SECRET });
    const configA = readSupabaseServiceConfig(envReaderA);
    configA.url = 'mutated-by-test';

    const envReaderB = makeEnvReader({ SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: FAKE_SECRET });
    const configB = readSupabaseServiceConfig(envReaderB);

    expect(configB.url).toBe(FAKE_URL);
    expect(configA).not.toBe(configB);
  });

  // 15. secret fake nunca aparece nas mensagens produzidas pelo modulo
  test('mensagens de erro nunca contem a secret fake', () => {
    const envReader = makeEnvReader({ SUPABASE_URL: FAKE_URL, SUPABASE_SERVICE_ROLE_KEY: '' });
    try {
      readSupabaseServiceConfig(envReader);
      throw new Error('deveria ter lancado');
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).not.toContain(FAKE_SECRET);
    }

    const envReaderAusente = makeEnvReader({});
    try {
      readSupabaseServiceConfig(envReaderAusente);
      throw new Error('deveria ter lancado');
    } catch (thrown) {
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      expect(message).not.toContain(FAKE_SECRET);
    }
  });

  describe('auditoria estatica de seguranca (supabaseServiceConfig.ts)', () => {
    const source = readFileSync(new URL('./supabaseServiceConfig.ts', import.meta.url), 'utf8');
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
