import { describe, expect, test } from 'vitest';
import { CANAL_LABELS, canalLabel, getCanalOptions } from './canalDisplay.js';
import { CANAIS } from '../constants.js';

describe('canalLabel', () => {
  test('mapeia whatsapp -> WhatsApp', () => {
    expect(canalLabel('whatsapp')).toBe('WhatsApp');
  });

  test('valor ja conhecido/curado (CANAIS) permanece inalterado', () => {
    expect(canalLabel('Facebook Marketplace')).toBe('Facebook Marketplace');
    expect(canalLabel('Tráfego Pago')).toBe('Tráfego Pago');
  });

  test('valor desconhecido nunca e convertido para Facebook Marketplace ou qualquer outro -> retorna o proprio valor', () => {
    expect(canalLabel('instagram_ads')).toBe('instagram_ads');
    expect(canalLabel('qualquer_coisa_nova')).toBe('qualquer_coisa_nova');
  });

  test('null/undefined/vazio -> passthrough, nunca lança', () => {
    expect(canalLabel(null)).toBe(null);
    expect(canalLabel(undefined)).toBe(undefined);
    expect(canalLabel('')).toBe('');
  });

  test('CANAL_LABELS contem exatamente o mapeamento esperado para whatsapp', () => {
    expect(CANAL_LABELS.whatsapp).toBe('WhatsApp');
  });
});

describe('getCanalOptions', () => {
  test('sem currentCanal -> apenas as options de CANAIS, mesma ordem, value===label', () => {
    const options = getCanalOptions(CANAIS, null);
    expect(options).toHaveLength(CANAIS.length);
    expect(options.map((o) => o.value)).toEqual(CANAIS);
    expect(options.every((o) => o.value === o.label)).toBe(true);
  });

  test('currentCanal vazio (string) -> nenhuma option extra', () => {
    const options = getCanalOptions(CANAIS, '');
    expect(options).toHaveLength(CANAIS.length);
  });

  test('currentCanal ja presente em CANAIS -> nenhuma duplicata', () => {
    const options = getCanalOptions(CANAIS, 'Indicação');
    expect(options).toHaveLength(CANAIS.length);
    expect(options.filter((o) => o.value === 'Indicação')).toHaveLength(1);
  });

  test('currentCanal=whatsapp -> adicionado ao final com rotulo WhatsApp, CANAIS preservado integralmente antes dele', () => {
    const options = getCanalOptions(CANAIS, 'whatsapp');
    expect(options).toHaveLength(CANAIS.length + 1);
    expect(options.slice(0, CANAIS.length).map((o) => o.value)).toEqual(CANAIS);
    const extra = options[options.length - 1];
    expect(extra).toEqual({ value: 'whatsapp', label: 'WhatsApp' });
  });

  test('currentCanal desconhecido (nao whatsapp, nao em CANAIS) -> adicionado com o PROPRIO valor como rotulo, nunca descartado nem convertido', () => {
    const options = getCanalOptions(CANAIS, 'novo_canal_futuro');
    expect(options).toHaveLength(CANAIS.length + 1);
    expect(options[options.length - 1]).toEqual({ value: 'novo_canal_futuro', label: 'novo_canal_futuro' });
  });

  test('nunca retorna Facebook Marketplace para um canal diferente de Facebook Marketplace', () => {
    const options = getCanalOptions(CANAIS, 'whatsapp');
    const extra = options.find((o) => o.value === 'whatsapp');
    expect(extra.label).not.toBe('Facebook Marketplace');
  });
});
