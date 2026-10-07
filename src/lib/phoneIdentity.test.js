import { describe, expect, it } from 'vitest';
import { normalizePhoneIdentity, PHONE_IDENTITY_STATUS } from './phoneIdentity.js';

// Fase 3.1.1 — matriz canônica da regra de identidade telefônica.
// Migrada integralmente da matriz já homologada em
// followUpAction.test.js (Fase 2D.2.A) — mesma semântica, mesmos
// casos, só realocada para a fonte de verdade. followUpAction.test.js
// continua cobrindo a API pública (normalizeWhatsAppPhone/
// buildWhatsAppHref) como teste de compatibilidade, não duplicação de
// regra.
describe('Fase 3.1.1 — normalizePhoneIdentity (regra canônica)', () => {
  // --- BR sem DDI (A, B, C) ---
  it('A) (51) 9 9232-2166 -> valid, 5551992322166', () => {
    expect(normalizePhoneIdentity('(51) 9 9232-2166')).toEqual({ status: PHONE_IDENTITY_STATUS.VALID, number: '5551992322166' });
  });

  it('B) 51 99232-2166 -> valid, 5551992322166', () => {
    expect(normalizePhoneIdentity('51 99232-2166')).toEqual({ status: PHONE_IDENTITY_STATUS.VALID, number: '5551992322166' });
  });

  it('C) 51992322166 -> valid, 5551992322166', () => {
    expect(normalizePhoneIdentity('51992322166')).toEqual({ status: PHONE_IDENTITY_STATUS.VALID, number: '5551992322166' });
  });

  // --- BR com +55 / 55 sem + / 0055 (D, E, F, G) — nunca duplica 55 ---
  it('D) +55 51 99232-2166 -> valid, 5551992322166 (sinal + interpretado antes do strip)', () => {
    expect(normalizePhoneIdentity('+55 51 99232-2166')).toEqual({ status: PHONE_IDENTITY_STATUS.VALID, number: '5551992322166' });
  });

  it('E) 55 51 99232-2166 -> valid, 5551992322166 (não prefixa outro 55)', () => {
    expect(normalizePhoneIdentity('55 51 99232-2166')).toEqual({ status: PHONE_IDENTITY_STATUS.VALID, number: '5551992322166' });
  });

  it('F) 5551992322166 -> valid, sem duplicar 55', () => {
    const r = normalizePhoneIdentity('5551992322166');
    expect(r).toEqual({ status: PHONE_IDENTITY_STATUS.VALID, number: '5551992322166' });
    expect(r.number.startsWith('5555')).toBe(false);
  });

  it('G) 0055 51 99232-2166 -> valid, 5551992322166 (só o prefixo explícito 0055, não qualquer 00)', () => {
    expect(normalizePhoneIdentity('0055 51 99232-2166')).toEqual({ status: PHONE_IDENTITY_STATUS.VALID, number: '5551992322166' });
  });

  // --- DDD ausente (H) — nunca inventa DDD ---
  it('H) 99232-2166 (sem DDD) -> não valid, number null', () => {
    const r = normalizePhoneIdentity('99232-2166');
    expect(r.status).not.toBe(PHONE_IDENTITY_STATUS.VALID);
    expect(r.number).toBeNull();
  });

  // --- Casos inválidos (I, J, K, L + extras) ---
  it('I) null -> invalid', () => {
    expect(normalizePhoneIdentity(null)).toEqual({ status: PHONE_IDENTITY_STATUS.INVALID, number: null });
  });

  it('J) undefined -> invalid', () => {
    expect(normalizePhoneIdentity(undefined)).toEqual({ status: PHONE_IDENTITY_STATUS.INVALID, number: null });
  });

  it("K) '' -> invalid", () => {
    expect(normalizePhoneIdentity('')).toEqual({ status: PHONE_IDENTITY_STATUS.INVALID, number: null });
  });

  it("'   ' (só espaços) -> invalid", () => {
    expect(normalizePhoneIdentity('   ')).toEqual({ status: PHONE_IDENTITY_STATUS.INVALID, number: null });
  });

  it('L) abc -> invalid', () => {
    expect(normalizePhoneIdentity('abc')).toEqual({ status: PHONE_IDENTITY_STATUS.INVALID, number: null });
  });

  it("'telefone' (letras, sem dígito nenhum) -> invalid", () => {
    expect(normalizePhoneIdentity('telefone')).toEqual({ status: PHONE_IDENTITY_STATUS.INVALID, number: null });
  });

  // --- Ramal/extensão (M, N, O + variante com ponto) — nunca mistura ramal no número ---
  it('M) (51) 3333-4444 ramal 123 -> ambiguous', () => {
    expect(normalizePhoneIdentity('(51) 3333-4444 ramal 123')).toEqual({ status: PHONE_IDENTITY_STATUS.AMBIGUOUS, number: null });
  });

  it('N) (51) 3333-4444 r. 123 -> ambiguous', () => {
    expect(normalizePhoneIdentity('(51) 3333-4444 r. 123')).toEqual({ status: PHONE_IDENTITY_STATUS.AMBIGUOUS, number: null });
  });

  it('O) (51) 3333-4444 ext 123 -> ambiguous', () => {
    expect(normalizePhoneIdentity('(51) 3333-4444 ext 123')).toEqual({ status: PHONE_IDENTITY_STATUS.AMBIGUOUS, number: null });
  });

  it('(51) 3333-4444 ext. 123 -> ambiguous', () => {
    expect(normalizePhoneIdentity('(51) 3333-4444 ext. 123')).toEqual({ status: PHONE_IDENTITY_STATUS.AMBIGUOUS, number: null });
  });

  // --- Sentinela de regressão do guard de ramal (Fase 3.1.1.2 — achado
  // MEDIUM da auditoria 3.1.1.1) ---
  //
  // Os 4 casos M/N/O/ext. acima SEMPRE davam ambiguous, mesmo numa
  // versão hipotética sem a guarda de ramal — porque o total de dígitos
  // resultante da concatenação ingênua (base + ramal) não caía em
  // nenhum comprimento reconhecido como válido. Isso significa que
  // nenhum deles de fato comprova que a guarda está funcionando: eles
  // passariam de qualquer forma, por um motivo diferente (comprimento),
  // mascarando uma eventual regressão real da guarda.
  //
  // Os 4 casos abaixo são desenhados deliberadamente para que a base
  // (DDD + 7 dígitos = 9 dígitos, estruturalmente invàlida por si só)
  // somada ao(s) dígito(s) do ramal/extensão (1 dígito) total EXATAMENTE
  // 10 dígitos — um comprimento reconhecido como BR válido
  // (BR_LOCAL_LENGTHS). Ou seja: SE a guarda de ramal for removida ou
  // quebrar, o resultado deixa de ser ambiguous e passa a ser
  // erroneamente valid, com o dígito do ramal silenciosamente
  // incorporado ao número (ex.: 555133334449). Confirmado por prova
  // adversarial antes de escrever este teste (ver relatório 3.1.1.2):
  // sem a guarda, as 4 entradas abaixo resolveriam para
  // {status: 'valid', number: '555133334449'} — nunca para isto aqui.
  describe('sentinela — guard de ramal precisa impedir, não só coincidir em comprimento', () => {
    const adversarial = [
      ['ramal', '51 3333444 ramal 9'],
      ['r.', '51 3333444 r. 9'],
      ['ext', '51 3333444 ext 9'],
      ['ext.', '51 3333444 ext. 9'],
    ];

    it.each(adversarial)('%s) %s -> ambiguous (nunca valid com o dígito do ramal incorporado)', (_label, input) => {
      const r = normalizePhoneIdentity(input);
      expect(r).toEqual({ status: PHONE_IDENTITY_STATUS.AMBIGUOUS, number: null });
      // Reforço explícito do contrato público (seção 6 da especificação
      // 3.1.1.2): nunca o número com o ramal silenciosamente embutido.
      expect(r.number).not.toBe('555133334449');
    });
  });

  // --- Internacional não-BR explícito (P, Q, R) — nunca prefixa 55, nunca vira 55+1 ---
  it('P) +1 415 555 0123 -> ambiguous, nunca prefixa 55', () => {
    const r = normalizePhoneIdentity('+1 415 555 0123');
    expect(r).toEqual({ status: PHONE_IDENTITY_STATUS.AMBIGUOUS, number: null });
  });

  it('Q) +351 21 123 4567 -> ambiguous', () => {
    expect(normalizePhoneIdentity('+351 21 123 4567')).toEqual({ status: PHONE_IDENTITY_STATUS.AMBIGUOUS, number: null });
  });

  it('R) +54 11 1234 5678 -> ambiguous', () => {
    expect(normalizePhoneIdentity('+54 11 1234 5678')).toEqual({ status: PHONE_IDENTITY_STATUS.AMBIGUOUS, number: null });
  });

  // --- Comprimentos estruturais BR (S, T, U, V) — fixo (8) e celular (9) ambos válidos ---
  it('S) BR estrutural de 10 dígitos (DDD + 8, fixo, sem DDI) -> valid', () => {
    expect(normalizePhoneIdentity('5133334444')).toEqual({ status: PHONE_IDENTITY_STATUS.VALID, number: '555133334444' });
  });

  it('T) BR estrutural de 11 dígitos (DDD + 9, celular, sem DDI) -> valid', () => {
    expect(normalizePhoneIdentity('51992322166')).toEqual({ status: PHONE_IDENTITY_STATUS.VALID, number: '5551992322166' });
  });

  it('U) 55 + BR de 10 dígitos (12 dígitos totais, já com DDI) -> valid', () => {
    expect(normalizePhoneIdentity('555133334444')).toEqual({ status: PHONE_IDENTITY_STATUS.VALID, number: '555133334444' });
  });

  it('V) 55 + BR de 11 dígitos (13 dígitos totais, já com DDI) -> valid', () => {
    expect(normalizePhoneIdentity('5551992322166')).toEqual({ status: PHONE_IDENTITY_STATUS.VALID, number: '5551992322166' });
  });

  // --- Comprimentos fora do reconhecido (W, X) ---
  it('W) comprimento excessivo, sem ramal explícito -> ambiguous', () => {
    expect(normalizePhoneIdentity('555199232216699')).toEqual({ status: PHONE_IDENTITY_STATUS.AMBIGUOUS, number: null });
  });

  it('X) comprimento insuficiente com alguns dígitos -> ambiguous (contrato: zero dígitos = invalid, dígitos insuficientes = ambiguous)', () => {
    expect(normalizePhoneIdentity('123')).toEqual({ status: PHONE_IDENTITY_STATUS.AMBIGUOUS, number: null });
  });

  // --- Propriedades simples sobre todos os casos VALID acima ---
  describe('propriedades sobre números VALID', () => {
    const validInputs = [
      '(51) 9 9232-2166', '51 99232-2166', '51992322166', '+55 51 99232-2166',
      '55 51 99232-2166', '5551992322166', '0055 51 99232-2166',
      '5133334444', '555133334444',
    ];

    it.each(validInputs)('%s -> number só com dígitos, começa com 55', (input) => {
      const r = normalizePhoneIdentity(input);
      expect(r.status).toBe(PHONE_IDENTITY_STATUS.VALID);
      expect(r.number).toMatch(/^\d+$/);
      expect(r.number.startsWith('55')).toBe(true);
    });
  });

  // --- Segurança: nenhum ambiguous/invalid/internacional/ramal produz VALID ---
  describe('segurança — nenhum caso incerto resolve para VALID', () => {
    const neverValid = [
      null, undefined, '', '   ', 'abc', 'telefone',
      '99232-2166', '123', '555199232216699',
      '(51) 3333-4444 ramal 123', '(51) 3333-4444 r. 123', '(51) 3333-4444 ext 123', '(51) 3333-4444 ext. 123',
      '+1 415 555 0123', '+351 21 123 4567', '+54 11 1234 5678',
    ];

    it.each(neverValid)('%s -> status nunca valid, number sempre null', (input) => {
      const r = normalizePhoneIdentity(input);
      expect(r.status).not.toBe(PHONE_IDENTITY_STATUS.VALID);
      expect(r.number).toBeNull();
    });
  });

  // --- Pureza/imutabilidade (seção 17) ---
  describe('pureza e imutabilidade', () => {
    it('não muta o input (objeto wrapper não aplicável — input é string/null/undefined, mas o valor original permanece intacto após a chamada)', () => {
      const input = '(51) 9 9232-2166';
      const copy = String(input);
      normalizePhoneIdentity(input);
      expect(input).toBe(copy);
    });

    it('é determinística: mesma entrada produz sempre a mesma saída (chamadas repetidas, sem estado global)', () => {
      const r1 = normalizePhoneIdentity('51992322166');
      const r2 = normalizePhoneIdentity('51992322166');
      expect(r1).toEqual(r2);
      expect(r1).not.toBe(r2); // objetos novos a cada chamada, nunca uma referência compartilhada/cache
    });

    it('resultado depende somente do input: duas chamadas com entradas diferentes nunca se influenciam', () => {
      const valid1 = normalizePhoneIdentity('51992322166');
      const ambiguous1 = normalizePhoneIdentity('+1 415 555 0123');
      const valid2 = normalizePhoneIdentity('51992322166');
      expect(valid1).toEqual(valid2);
      expect(ambiguous1.status).toBe(PHONE_IDENTITY_STATUS.AMBIGUOUS);
    });
  });
});
