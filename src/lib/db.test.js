import { describe, expect, it } from 'vitest';
import { interactionToRow, interactionFromRow, leadToRow } from './db.js';
import { computeNoteInteractionData, computeStageChangeInteraction, computeCommercialInteractionData } from '../hooks/useAppState.js';

// Fase 2A.1.1 — fecha a lacuna identificada na validação de produção da
// Fase 2A.1: as funções de domínio (computeNoteInteractionData/
// computeStageChangeInteraction) já eram testadas isoladamente, mas nunca
// encadeadas através de interactionToRow até o payload literal que é
// enviado ao Supabase. Estes testes cobrem exatamente essa fronteira.

describe('interactionToRow — fronteira de serialização para o Supabase', () => {
  it('A) note: computeNoteInteractionData -> interactionToRow preserva todos os campos esperados', () => {
    const data = computeNoteInteractionData('l1', 'Cliente pediu para ligar semana que vem', 'user-abc');
    const row = interactionToRow(data);
    expect(row).toMatchObject({
      lead_id: 'l1',
      type: 'note',
      direction: 'internal',
      channel: 'manual',
      content: 'Cliente pediu para ligar semana que vem',
      metadata: { activity_class: 'internal', source: 'user' },
      created_by: 'user-abc',
    });
  });

  it('B) stage_change: computeStageChangeInteraction -> interactionToRow preserva todos os campos esperados', () => {
    const prevLead = { id: 'l1', etapa: 'Proposta' };
    const interaction = computeStageChangeInteraction(prevLead, 'Negociação', 'user-abc');
    const row = interactionToRow(interaction);
    expect(row).toMatchObject({
      lead_id: 'l1',
      type: 'stage_change',
      direction: 'internal',
      channel: 'crm',
      metadata: {
        from_stage: 'Proposta',
        to_stage: 'Negociação',
        activity_class: 'internal',
        source: 'user',
      },
      created_by: 'user-abc',
    });
  });

  it('C) interactionToRow não reconstrói nem elimina campos de metadata adicionais (preparação para a Fase 2A.2)', () => {
    const data = {
      leadId: 'l1',
      type: 'call',
      direction: 'outbound',
      channel: 'phone',
      content: '',
      metadata: {
        activity_class: 'attempt',
        source: 'user',
        outcome: 'no_answer',
        task_id: 'task-123',
        future_field: 'preserve-me',
      },
      createdBy: 'user-abc',
    };
    const row = interactionToRow(data);
    expect(row.metadata).toEqual({
      activity_class: 'attempt',
      source: 'user',
      outcome: 'no_answer',
      task_id: 'task-123',
      future_field: 'preserve-me',
    });
  });

  it('E) Fase 2A.2 — call_no_answer (attempt): computeCommercialInteractionData -> interactionToRow preserva tudo', () => {
    const data = computeCommercialInteractionData('l1', 'call_no_answer', 'user-abc');
    const row = interactionToRow(data);
    expect(row).toMatchObject({
      lead_id: 'l1',
      type: 'call',
      direction: 'outbound',
      channel: 'phone',
      metadata: { activity_class: 'attempt', outcome: 'no_answer', source: 'user' },
      created_by: 'user-abc',
    });
  });

  it('F) Fase 2A.2 — whatsapp_received (engagement): computeCommercialInteractionData -> interactionToRow preserva tudo', () => {
    const data = computeCommercialInteractionData('l1', 'whatsapp_received', 'user-abc');
    const row = interactionToRow(data);
    expect(row).toMatchObject({
      lead_id: 'l1',
      type: 'whatsapp',
      direction: 'inbound',
      channel: 'whatsapp',
      metadata: { activity_class: 'engagement', source: 'user' },
      created_by: 'user-abc',
    });
  });

  it('G) Fase 2A.3 — computeCommercialInteractionData + metadata.task_id -> interactionToRow preserva tudo até o payload final', () => {
    const data = computeCommercialInteractionData('l1', 'call_connected', 'user-abc');
    const withTaskId = { ...data, metadata: { ...data.metadata, task_id: 'task-contato-lilliane' } };
    const row = interactionToRow(withTaskId);
    expect(row).toMatchObject({
      lead_id: 'l1',
      type: 'call',
      direction: 'outbound',
      channel: 'phone',
      metadata: { activity_class: 'engagement', outcome: 'connected', source: 'user', task_id: 'task-contato-lilliane' },
      created_by: 'user-abc',
    });
  });

  it('D) round-trip interactionToRow -> interactionFromRow preserva metadata, created_by e occurred_at', () => {
    const data = computeNoteInteractionData('l1', 'Nota de teste', 'user-abc');
    const occurredAt = '2026-10-10T11:00:00.000Z';
    const row = interactionToRow({ ...data, occurredAt });
    const roundTripped = interactionFromRow({
      id: 'interaction-1',
      lead_id: row.lead_id,
      type: row.type,
      direction: row.direction,
      channel: row.channel,
      content: row.content,
      metadata: row.metadata,
      created_by: row.created_by,
      occurred_at: row.occurred_at,
      created_at: '2026-10-10T11:00:00.000Z',
    });
    expect(roundTripped).toMatchObject({
      leadId: 'l1',
      metadata: { activity_class: 'internal', source: 'user' },
      createdBy: 'user-abc',
      occurredAt,
    });
  });
});

// Fase 3.1.4.1 — sincronização dos writers de identidade telefônica:
// leadToRow passa a derivar phone_normalized (sempre a partir de
// telefone, via src/lib/phoneIdentity.js) sem jamais aceitar o campo
// como entrada. Estes testes cobrem a fronteira de serialização exposta
// por essa mudança — nunca reimplementam a regra de normalização, que
// já é testada exaustivamente em phoneIdentity.test.js.
describe('leadToRow — sincronização de phone_normalized (Fase 3.1.4.1)', () => {
  it('T-01) telefone VALID (BR sem DDI) -> phone_normalized canônico com DDI 55', () => {
    const row = leadToRow({ nome: 'Ana', telefone: '51999887766' });
    expect(row.phone_normalized).toBe('5551999887766');
  });

  it('T-02) telefone INVALID (sem nenhum dígito) -> phone_normalized null', () => {
    const row = leadToRow({ nome: 'Ana', telefone: 'abc' });
    expect(row.phone_normalized).toBeNull();
  });

  it('T-03) telefone AMBIGUOUS (comprimento não reconhecido) -> phone_normalized null', () => {
    const row = leadToRow({ nome: 'Ana', telefone: '123' });
    expect(row.phone_normalized).toBeNull();
  });

  it("T-04) telefone '' -> phone_normalized null", () => {
    const row = leadToRow({ nome: 'Ana', telefone: '' });
    expect(row.phone_normalized).toBeNull();
  });

  it('T-05) telefone null -> phone_normalized null', () => {
    const row = leadToRow({ nome: 'Ana', telefone: null });
    expect(row.phone_normalized).toBeNull();
  });

  it('T-06) telefone presente explicitamente como undefined -> phone_normalized null (propriedade permanece no row)', () => {
    const data = { nome: 'Ana', telefone: undefined };
    expect(Object.prototype.hasOwnProperty.call(data, 'telefone')).toBe(true);
    const row = leadToRow(data);
    expect(Object.prototype.hasOwnProperty.call(row, 'phone_normalized')).toBe(true);
    expect(row.phone_normalized).toBeNull();
  });

  it('T-07) payload SEM a propriedade telefone -> row NÃO possui a chave phone_normalized', () => {
    const data = { nome: 'Ana' };
    expect(Object.prototype.hasOwnProperty.call(data, 'telefone')).toBe(false);
    const row = leadToRow(data);
    expect(Object.prototype.hasOwnProperty.call(row, 'phone_normalized')).toBe(false);
  });

  it('T-08) telefone VALID + phone_normalized malicioso no payload -> valor malicioso é ignorado', () => {
    const row = leadToRow({ nome: 'Ana', telefone: '51999887766', phone_normalized: '0000000000000' });
    expect(row.phone_normalized).toBe('5551999887766');
  });

  it('T-09) telefone VALID + phoneNormalized (camelCase) malicioso no payload -> valor malicioso é ignorado', () => {
    const row = leadToRow({ nome: 'Ana', telefone: '51999887766', phoneNormalized: '0000000000000' });
    expect(row.phone_normalized).toBe('5551999887766');
    expect(row).not.toHaveProperty('phoneNormalized');
  });

  it('T-10) payload tipo update SEM telefone, mas com phone_normalized malicioso -> chave não sobrevive no row', () => {
    const data = { nome: 'Ana', phone_normalized: '0000000000000' };
    expect(Object.prototype.hasOwnProperty.call(data, 'telefone')).toBe(false);
    const row = leadToRow(data);
    expect(Object.prototype.hasOwnProperty.call(row, 'phone_normalized')).toBe(false);
  });

  it('T-11) telefone VALID já com DDI 55 -> não duplica o prefixo', () => {
    const row = leadToRow({ nome: 'Ana', telefone: '5551999887766' });
    expect(row.phone_normalized).toBe('5551999887766');
  });

  it('T-12) telefone com ramal/extensão -> phone_normalized null', () => {
    const row = leadToRow({ nome: 'Ana', telefone: '51 3333444 ramal 9' });
    expect(row.phone_normalized).toBeNull();
  });

  it('T-13) telefone internacional explícito não-BR -> phone_normalized null', () => {
    const row = leadToRow({ nome: 'Ana', telefone: '+1 555 123 4567' });
    expect(row.phone_normalized).toBeNull();
  });

  it('fail-closed) telefone cujo toString() lança -> leadToRow lança e não retorna row parcial', () => {
    const evilPhone = { toString() { throw new Error('boom'); } };
    let thrown = null;
    let result;
    try {
      result = leadToRow({ nome: 'Ana', telefone: evilPhone });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeNull();
    expect(result).toBeUndefined();
  });

  it('regressão) leadToRow preserva todos os campos pré-existentes exatamente como antes desta fase', () => {
    const data = {
      nome: 'Carlos',
      telefone: '51999887766',
      cidade: 'Porto Alegre',
      canal: 'facebook',
      produto: 'Consórcio',
      etapa: 'Proposta',
      tipo: 'imovel',
      credito: '',
      entrada: '',
      parcela: '',
      lance: '',
      valor: '',
      valorImovel: '',
      proximoContato: '2026-10-10',
      proximoContatoHorario: '14:00',
      notas: 'Nota de teste',
      tags: ['quente'],
      criadoEm: '2026-10-01T10:00:00.000Z',
      ultimaAtualizacao: '2026-10-05T10:00:00.000Z',
      nextActionType: 'call',
      nextActionNote: 'Ligar de volta',
      leadTemperature: 'quente',
      priority: 'alta',
      lostReason: '',
      lostReasonNote: '',
      wonAt: null,
      lostAt: null,
    };
    const row = leadToRow(data);
    expect(row).toMatchObject({
      nome: 'Carlos',
      telefone: '51999887766',
      phone_normalized: '5551999887766',
      cidade: 'Porto Alegre',
      canal: 'facebook',
      produto: 'Consórcio',
      etapa: 'Proposta',
      tipo: 'imovel',
      credito: null,
      entrada: null,
      parcela: null,
      lance: null,
      valor: null,
      valor_imovel: null,
      proximo_contato: '2026-10-10',
      proximo_contato_horario: '14:00',
      notas: 'Nota de teste',
      tags: ['quente'],
      criado_em: '2026-10-01T10:00:00.000Z',
      ultima_atualizacao: '2026-10-05T10:00:00.000Z',
      next_action_type: 'call',
      next_action_note: 'Ligar de volta',
      lead_temperature: 'quente',
      priority: 'alta',
      lost_reason: null,
      lost_reason_note: null,
      won_at: null,
      lost_at: null,
    });
  });

  it('regressão) leadToRow não possui criado_em/ultima_atualizacao/won_at/lost_at quando ausentes do payload (comportamento pré-existente inalterado)', () => {
    const row = leadToRow({ nome: 'Carlos', telefone: '51999887766' });
    expect(Object.prototype.hasOwnProperty.call(row, 'criado_em')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, 'ultima_atualizacao')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, 'won_at')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(row, 'lost_at')).toBe(false);
    // leadToRow nunca teve (antes ou depois desta fase) um campo
    // deleted_at em sua saída — essa coluna só é lida em leadFromRow,
    // nunca escrita por leadToRow. Confirmado aqui para não inventar
    // uma regressão sobre um campo que nunca existiu neste contrato.
    expect(Object.prototype.hasOwnProperty.call(row, 'deleted_at')).toBe(false);
  });
});
