import { describe, expect, it } from 'vitest';
import { buildTelHref } from './followUpAction.js';

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
