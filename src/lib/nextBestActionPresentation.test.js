import { describe, expect, it } from 'vitest';
import { presentNextBestAction } from './nextBestActionPresentation.js';

// Fase 2E.2 — testes puros, sem motor, sem React Testing Library. O
// insumo é sempre um objeto NBA já pronto (o mesmo formato que
// evaluateNextBestAction, 2E.1, devolve) — esta camada nunca reavalia
// lead/interactions/followUpEvaluation, então os testes não precisam
// deles.

function nba(overrides) {
  return {
    type: 'call', channel: 'phone', intent: 'first_contact',
    reasonCode: 'never_contacted', confidence: 'explicit',
    ...overrides,
  };
}

describe('Fase 2E.2 — presentNextBestAction — happy path', () => {
  it('A) call/phone/first_contact/never_contacted/explicit -> Ligação / Primeiro contato', () => {
    expect(presentNextBestAction(nba({}))).toEqual({ actionLabel: 'Ligação', reasonLabel: 'Primeiro contato' });
  });

  it('B) whatsapp/whatsapp/first_contact/never_contacted/explicit -> WhatsApp / Primeiro contato', () => {
    expect(presentNextBestAction(nba({ type: 'whatsapp', channel: 'whatsapp' }))).toEqual({ actionLabel: 'WhatsApp', reasonLabel: 'Primeiro contato' });
  });

  it('C) call/phone/retry/no_response_after_attempt/rule -> Ligação / Nova tentativa de contato', () => {
    expect(presentNextBestAction(nba({ intent: 'retry', reasonCode: 'no_response_after_attempt', confidence: 'rule' })))
      .toEqual({ actionLabel: 'Ligação', reasonLabel: 'Nova tentativa de contato' });
  });

  it('D) whatsapp/whatsapp/retry/no_response_after_attempt/rule -> WhatsApp / Nova tentativa de contato', () => {
    expect(presentNextBestAction(nba({ type: 'whatsapp', channel: 'whatsapp', intent: 'retry', reasonCode: 'no_response_after_attempt', confidence: 'rule' })))
      .toEqual({ actionLabel: 'WhatsApp', reasonLabel: 'Nova tentativa de contato' });
  });

  it('E) call/phone/retry/cadence_exhausted/rule -> Ligação / Cadência de contato esgotada', () => {
    expect(presentNextBestAction(nba({ intent: 'retry', reasonCode: 'cadence_exhausted', confidence: 'rule' })))
      .toEqual({ actionLabel: 'Ligação', reasonLabel: 'Cadência de contato esgotada' });
  });

  it('F) whatsapp/whatsapp/reactivate/reactivation_due/rule -> WhatsApp / Reativação', () => {
    expect(presentNextBestAction(nba({ type: 'whatsapp', channel: 'whatsapp', intent: 'reactivate', reasonCode: 'reactivation_due', confidence: 'rule' })))
      .toEqual({ actionLabel: 'WhatsApp', reasonLabel: 'Reativação' });
  });

  it('G) call/phone/retry/no_new_attempt_since_engagement/rule -> Ligação / Retomar após resposta do cliente', () => {
    expect(presentNextBestAction(nba({ intent: 'retry', reasonCode: 'no_new_attempt_since_engagement', confidence: 'rule' })))
      .toEqual({ actionLabel: 'Ligação', reasonLabel: 'Retomar após resposta do cliente' });
  });

  it('H) whatsapp/whatsapp/proposal_follow_up/no_response_after_proposal/explicit -> WhatsApp / Follow-up da proposta', () => {
    expect(presentNextBestAction(nba({ type: 'whatsapp', channel: 'whatsapp', intent: 'proposal_follow_up', reasonCode: 'no_response_after_proposal', confidence: 'explicit' })))
      .toEqual({ actionLabel: 'WhatsApp', reasonLabel: 'Follow-up da proposta' });
  });

  it('I) meeting/in_person/first_contact/never_contacted/explicit -> Reunião / Primeiro contato', () => {
    expect(presentNextBestAction(nba({ type: 'meeting', channel: 'in_person' })))
      .toEqual({ actionLabel: 'Reunião', reasonLabel: 'Primeiro contato' });
  });

  it('J) proposal/manual/first_contact/never_contacted/explicit -> Proposta / Primeiro contato', () => {
    expect(presentNextBestAction(nba({ type: 'proposal', channel: 'manual' })))
      .toEqual({ actionLabel: 'Proposta', reasonLabel: 'Primeiro contato' });
  });
});

describe('Fase 2E.2 — presentNextBestAction — segurança / contrato inválido', () => {
  it('K) null -> null', () => {
    expect(presentNextBestAction(null)).toBeNull();
  });

  it('L) undefined -> null', () => {
    expect(presentNextBestAction(undefined)).toBeNull();
  });

  it('M) {} -> null', () => {
    expect(presentNextBestAction({})).toBeNull();
  });

  it('N) type desconhecido -> null, zero label fabricada', () => {
    expect(presentNextBestAction(nba({ type: 'carta_pombo', channel: 'pombo' }))).toBeNull();
  });

  it('O) channel ausente -> null', () => {
    const { channel, ...rest } = nba({});
    expect(presentNextBestAction(rest)).toBeNull();
  });

  it('P) channel incompatível com type (call + whatsapp) -> null, nunca corrigido', () => {
    expect(presentNextBestAction(nba({ type: 'call', channel: 'whatsapp' }))).toBeNull();
  });

  it('P.1) channel incompatível (whatsapp + phone) -> null', () => {
    expect(presentNextBestAction(nba({ type: 'whatsapp', channel: 'phone', intent: 'retry', reasonCode: 'no_response_after_attempt', confidence: 'rule' }))).toBeNull();
  });

  it('Q) intent ausente -> null', () => {
    const { intent, ...rest } = nba({});
    expect(presentNextBestAction(rest)).toBeNull();
  });

  it('R) intent incompatível com reasonCode (never_contacted + retry) -> null', () => {
    expect(presentNextBestAction(nba({ intent: 'retry' }))).toBeNull();
  });

  it('R.1) intent incompatível (reactivation_due + retry em vez de reactivate) -> null', () => {
    expect(presentNextBestAction(nba({ intent: 'retry', reasonCode: 'reactivation_due', confidence: 'rule' }))).toBeNull();
  });

  it('S) reasonCode ausente -> null', () => {
    const { reasonCode, ...rest } = nba({});
    expect(presentNextBestAction(rest)).toBeNull();
  });

  it('T) reasonCode desconhecido/legado -> null', () => {
    expect(presentNextBestAction(nba({ reasonCode: 'reason_futuro_desconhecido' }))).toBeNull();
  });

  it('U) confidence ausente -> null', () => {
    const { confidence, ...rest } = nba({});
    expect(presentNextBestAction(rest)).toBeNull();
  });

  it('V) confidence desconhecido -> null', () => {
    expect(presentNextBestAction(nba({ confidence: 'ia_generativa' }))).toBeNull();
  });

  it('input não-objeto (string) -> null, sem lançar', () => {
    expect(() => presentNextBestAction('call')).not.toThrow();
    expect(presentNextBestAction('call')).toBeNull();
  });

  it('input não-objeto (number) -> null, sem lançar', () => {
    expect(presentNextBestAction(42)).toBeNull();
  });
});

describe('Fase 2E.2 — presentNextBestAction — imutabilidade e determinismo', () => {
  it('não muta o objeto nba recebido', () => {
    const input = nba({});
    const snapshot = JSON.parse(JSON.stringify(input));
    presentNextBestAction(input);
    expect(input).toEqual(snapshot);
  });

  it('objeto retornado é novo — mutar o retorno não afeta o input', () => {
    const input = nba({});
    const result = presentNextBestAction(input);
    result.actionLabel = 'alterado';
    expect(input.type).toBe('call');
    expect(presentNextBestAction(input)).toEqual({ actionLabel: 'Ligação', reasonLabel: 'Primeiro contato' });
  });

  it('mesma entrada produz exatamente a mesma saída', () => {
    const input = nba({ intent: 'retry', reasonCode: 'cadence_exhausted', confidence: 'rule' });
    expect(presentNextBestAction(input)).toEqual(presentNextBestAction(input));
  });
});

describe('Fase 2E.2 — auditoria de copy (sem timing, sem fato não comprovado)', () => {
  it('nenhum label contém palavras de timing', () => {
    const forbidden = /agora|hoje|amanhã|em \d+ horas?|vencid|aguarde|espere/i;
    const allNba = [
      nba({}),
      nba({ type: 'whatsapp', channel: 'whatsapp', intent: 'retry', reasonCode: 'no_response_after_attempt', confidence: 'rule' }),
      nba({ intent: 'retry', reasonCode: 'cadence_exhausted', confidence: 'rule' }),
      nba({ type: 'whatsapp', channel: 'whatsapp', intent: 'reactivate', reasonCode: 'reactivation_due', confidence: 'rule' }),
      nba({ intent: 'retry', reasonCode: 'no_new_attempt_since_engagement', confidence: 'rule' }),
      nba({ type: 'whatsapp', channel: 'whatsapp', intent: 'proposal_follow_up', reasonCode: 'no_response_after_proposal', confidence: 'explicit' }),
      nba({ type: 'meeting', channel: 'in_person' }),
      nba({ type: 'proposal', channel: 'manual' }),
    ];
    allNba.forEach((input) => {
      const result = presentNextBestAction(input);
      expect(result.actionLabel).not.toMatch(forbidden);
      expect(result.reasonLabel).not.toMatch(forbidden);
    });
  });

  it('nenhum label contém confidence (rule/explicit) nem termos técnicos de confiança', () => {
    const forbidden = /\brule\b|\bexplicit\b|confiança|automátic/i;
    const result = presentNextBestAction(nba({}));
    expect(result.actionLabel).not.toMatch(forbidden);
    expect(result.reasonLabel).not.toMatch(forbidden);
    expect(result).not.toHaveProperty('confidence');
  });

  it('nenhum label afirma fato comercial não comprovado (ex. "interessado", "quente")', () => {
    const forbidden = /interessad|quer comprar|ignorou|recusou|visualizou|está quente/i;
    const result = presentNextBestAction(nba({ intent: 'retry', reasonCode: 'no_new_attempt_since_engagement', confidence: 'rule' }));
    expect(result.reasonLabel).not.toMatch(forbidden);
  });
});
