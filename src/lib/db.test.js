import { describe, expect, it } from 'vitest';
import { interactionToRow, interactionFromRow } from './db.js';
import { computeNoteInteractionData, computeStageChangeInteraction } from '../hooks/useAppState.js';

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
