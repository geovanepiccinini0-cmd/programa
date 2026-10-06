import { describe, expect, it } from 'vitest';
import { buildTelHref, buildWhatsAppHref, normalizeWhatsAppPhone, WHATSAPP_PHONE_STATUS } from './followUpAction.js';

describe('Fase 2D.1 — buildTelHref', () => {
  it('telefone formatado (com DDD, espaço e traço) -> tel: só com dígitos', () => {
    expect(buildTelHref('(81) 9 8291-2187')).toBe('tel:81982912187');
  });

  it('telefone já numérico puro', () => {
    expect(buildTelHref('81982912187')).toBe('tel:81982912187');
  });

  it('telefone com espaços e pontuação variados', () => {
    expect(buildTelHref('81 9.8291.2187')).toBe('tel:81982912187');
  });

  it('string vazia -> null', () => {
    expect(buildTelHref('')).toBeNull();
  });

  it('null -> null', () => {
    expect(buildTelHref(null)).toBeNull();
  });

  it('undefined -> null', () => {
    expect(buildTelHref(undefined)).toBeNull();
  });

  it('string sem nenhum dígito -> null', () => {
    expect(buildTelHref('sem telefone')).toBeNull();
  });
});

// Fase 2D.2.A — buildTelHref continua EXATAMENTE como estava (regressão
// explícita, não só "os testes antigos passam"): a política rígida nova
// é só para WhatsApp, buildTelHref permanece deliberadamente permissivo.
describe('Fase 2D.2.A — regressão explícita de buildTelHref', () => {
  it('buildTelHref continua permissivo (não adota a política rígida do WhatsApp)', () => {
    expect(buildTelHref('(51) 9 9232-2166')).toBe('tel:51992322166');
  });
});

describe('Fase 2D.2.A — normalizeWhatsAppPhone / buildWhatsAppHref', () => {
  // --- BR sem DDI (A, B, C) ---
  it('A) (51) 9 9232-2166 -> valid, 5551992322166', () => {
    const r = normalizeWhatsAppPhone('(51) 9 9232-2166');
    expect(r).toEqual({ status: WHATSAPP_PHONE_STATUS.VALID, number: '5551992322166' });
    expect(buildWhatsAppHref('(51) 9 9232-2166')).toBe('https://wa.me/5551992322166');
  });

  it('B) 51 99232-2166 -> valid, 5551992322166', () => {
    expect(normalizeWhatsAppPhone('51 99232-2166')).toEqual({ status: WHATSAPP_PHONE_STATUS.VALID, number: '5551992322166' });
  });

  it('C) 51992322166 -> valid, 5551992322166', () => {
    expect(normalizeWhatsAppPhone('51992322166')).toEqual({ status: WHATSAPP_PHONE_STATUS.VALID, number: '5551992322166' });
  });

  // --- BR com +55 / 55 sem + / 0055 (D, E, F, G) ---
  it('D) +55 51 99232-2166 -> valid, 5551992322166 (sinal + interpretado antes do strip)', () => {
    expect(normalizeWhatsAppPhone('+55 51 99232-2166')).toEqual({ status: WHATSAPP_PHONE_STATUS.VALID, number: '5551992322166' });
  });

  it('E) 55 51 99232-2166 -> valid, 5551992322166 (não prefixa outro 55)', () => {
    expect(normalizeWhatsAppPhone('55 51 99232-2166')).toEqual({ status: WHATSAPP_PHONE_STATUS.VALID, number: '5551992322166' });
  });

  it('F) 5551992322166 -> valid, sem duplicar 55', () => {
    const r = normalizeWhatsAppPhone('5551992322166');
    expect(r).toEqual({ status: WHATSAPP_PHONE_STATUS.VALID, number: '5551992322166' });
    expect(r.number.startsWith('5555')).toBe(false);
  });

  it('G) 0055 51 99232-2166 -> valid, 5551992322166 (só o prefixo explícito 0055, não qualquer 00)', () => {
    expect(normalizeWhatsAppPhone('0055 51 99232-2166')).toEqual({ status: WHATSAPP_PHONE_STATUS.VALID, number: '5551992322166' });
  });

  // --- DDD ausente (H) ---
  it('H) 99232-2166 (sem DDD) -> não valid, href null (nunca inventa DDD)', () => {
    const r = normalizeWhatsAppPhone('99232-2166');
    expect(r.status).not.toBe(WHATSAPP_PHONE_STATUS.VALID);
    expect(r.number).toBeNull();
    expect(buildWhatsAppHref('99232-2166')).toBeNull();
  });

  // --- Casos inválidos (I, J, K, L + extras do guardrail 14) ---
  it('I) null -> invalid, href null', () => {
    expect(normalizeWhatsAppPhone(null)).toEqual({ status: WHATSAPP_PHONE_STATUS.INVALID, number: null });
    expect(buildWhatsAppHref(null)).toBeNull();
  });

  it('J) undefined -> invalid, href null', () => {
    expect(normalizeWhatsAppPhone(undefined)).toEqual({ status: WHATSAPP_PHONE_STATUS.INVALID, number: null });
    expect(buildWhatsAppHref(undefined)).toBeNull();
  });

  it("K) '' -> invalid, href null", () => {
    expect(normalizeWhatsAppPhone('')).toEqual({ status: WHATSAPP_PHONE_STATUS.INVALID, number: null });
    expect(buildWhatsAppHref('')).toBeNull();
  });

  it("'   ' (só espaços) -> invalid, href null", () => {
    expect(normalizeWhatsAppPhone('   ')).toEqual({ status: WHATSAPP_PHONE_STATUS.INVALID, number: null });
  });

  it('L) abc -> invalid, href null', () => {
    expect(normalizeWhatsAppPhone('abc')).toEqual({ status: WHATSAPP_PHONE_STATUS.INVALID, number: null });
    expect(buildWhatsAppHref('abc')).toBeNull();
  });

  it("'telefone' (letras, sem dígito nenhum) -> invalid", () => {
    expect(normalizeWhatsAppPhone('telefone')).toEqual({ status: WHATSAPP_PHONE_STATUS.INVALID, number: null });
  });

  // --- Ramal/extensão (M, N, O + variante com ponto) ---
  it('M) (51) 3333-4444 ramal 123 -> ambiguous, href null (nunca mistura o ramal no número)', () => {
    const r = normalizeWhatsAppPhone('(51) 3333-4444 ramal 123');
    expect(r).toEqual({ status: WHATSAPP_PHONE_STATUS.AMBIGUOUS, number: null });
    expect(buildWhatsAppHref('(51) 3333-4444 ramal 123')).toBeNull();
  });

  it('N) (51) 3333-4444 r. 123 -> ambiguous, href null', () => {
    expect(normalizeWhatsAppPhone('(51) 3333-4444 r. 123')).toEqual({ status: WHATSAPP_PHONE_STATUS.AMBIGUOUS, number: null });
  });

  it('O) (51) 3333-4444 ext 123 -> ambiguous, href null', () => {
    expect(normalizeWhatsAppPhone('(51) 3333-4444 ext 123')).toEqual({ status: WHATSAPP_PHONE_STATUS.AMBIGUOUS, number: null });
  });

  it('(51) 3333-4444 ext. 123 -> ambiguous, href null', () => {
    expect(normalizeWhatsAppPhone('(51) 3333-4444 ext. 123')).toEqual({ status: WHATSAPP_PHONE_STATUS.AMBIGUOUS, number: null });
  });

  // --- Internacional não-BR explícito (P, Q, R) ---
  it('P) +1 415 555 0123 -> ambiguous, href null, nunca prefixa 55', () => {
    const r = normalizeWhatsAppPhone('+1 415 555 0123');
    expect(r).toEqual({ status: WHATSAPP_PHONE_STATUS.AMBIGUOUS, number: null });
    expect(buildWhatsAppHref('+1 415 555 0123')).toBeNull();
  });

  it('Q) +351 21 123 4567 -> ambiguous, href null', () => {
    expect(normalizeWhatsAppPhone('+351 21 123 4567')).toEqual({ status: WHATSAPP_PHONE_STATUS.AMBIGUOUS, number: null });
  });

  it('R) +54 11 1234 5678 -> ambiguous, href null', () => {
    expect(normalizeWhatsAppPhone('+54 11 1234 5678')).toEqual({ status: WHATSAPP_PHONE_STATUS.AMBIGUOUS, number: null });
  });

  // --- Comprimentos estruturais BR (S, T, U, V) ---
  it('S) BR estrutural de 10 dígitos (DDD + 8, fixo, sem DDI) -> valid', () => {
    expect(normalizeWhatsAppPhone('5133334444')).toEqual({ status: WHATSAPP_PHONE_STATUS.VALID, number: '555133334444' });
  });

  it('T) BR estrutural de 11 dígitos (DDD + 9, celular, sem DDI) -> valid', () => {
    expect(normalizeWhatsAppPhone('51992322166')).toEqual({ status: WHATSAPP_PHONE_STATUS.VALID, number: '5551992322166' });
  });

  it('U) 55 + BR de 10 dígitos (12 dígitos totais, já com DDI) -> valid', () => {
    expect(normalizeWhatsAppPhone('555133334444')).toEqual({ status: WHATSAPP_PHONE_STATUS.VALID, number: '555133334444' });
  });

  it('V) 55 + BR de 11 dígitos (13 dígitos totais, já com DDI) -> valid', () => {
    expect(normalizeWhatsAppPhone('5551992322166')).toEqual({ status: WHATSAPP_PHONE_STATUS.VALID, number: '5551992322166' });
  });

  // --- Comprimentos fora do reconhecido (W, X) ---
  it('W) comprimento excessivo, sem ramal explícito -> ambiguous, href null', () => {
    expect(normalizeWhatsAppPhone('555199232216699')).toEqual({ status: WHATSAPP_PHONE_STATUS.AMBIGUOUS, number: null });
  });

  it('X) comprimento insuficiente com alguns dígitos -> ambiguous (contrato: zero dígitos = invalid, dígitos insuficientes = ambiguous), href null', () => {
    expect(normalizeWhatsAppPhone('123')).toEqual({ status: WHATSAPP_PHONE_STATUS.AMBIGUOUS, number: null });
    expect(buildWhatsAppHref('123')).toBeNull();
  });

  // --- Propriedades simples (seção 21) sobre todos os casos VALID acima ---
  describe('propriedades sobre números VALID', () => {
    const validInputs = [
      '(51) 9 9232-2166', '51 99232-2166', '51992322166', '+55 51 99232-2166',
      '55 51 99232-2166', '5551992322166', '0055 51 99232-2166',
      '5133334444', '555133334444',
    ];

    it.each(validInputs)('%s -> number só com dígitos, começa com 55, buildWhatsAppHref termina exatamente nele', (input) => {
      const r = normalizeWhatsAppPhone(input);
      expect(r.status).toBe(WHATSAPP_PHONE_STATUS.VALID);
      expect(r.number).toMatch(/^\d+$/);
      expect(r.number.startsWith('55')).toBe(true);
      expect(buildWhatsAppHref(input)).toBe(`https://wa.me/${r.number}`);
    });
  });

  // --- Segurança (seção 22): nenhum ambiguous/invalid/internacional/ramal produz URL ---
  describe('segurança — nenhum caso incerto produz URL', () => {
    const neverProducesUrl = [
      null, undefined, '', '   ', 'abc', 'telefone',
      '99232-2166', '123', '555199232216699',
      '(51) 3333-4444 ramal 123', '(51) 3333-4444 r. 123', '(51) 3333-4444 ext 123', '(51) 3333-4444 ext. 123',
      '+1 415 555 0123', '+351 21 123 4567', '+54 11 1234 5678',
    ];

    it.each(neverProducesUrl)('%s -> buildWhatsAppHref null, status nunca valid', (input) => {
      expect(buildWhatsAppHref(input)).toBeNull();
      expect(normalizeWhatsAppPhone(input).status).not.toBe(WHATSAPP_PHONE_STATUS.VALID);
    });
  });
});
