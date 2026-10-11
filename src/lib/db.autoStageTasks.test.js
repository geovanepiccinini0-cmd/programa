import { describe, expect, test, vi, beforeEach } from 'vitest';

// Etapa D — valida tasksApi.insertAutoStage e a serialização de
// etapa_gatilho (taskToRow/taskFromRow) com um cliente Supabase
// SIMULADO (mock da fronteira ./supabaseClient.js, nunca rede real),
// mesmo padrão já usado em db.setStatus.test.js (PR #72) e
// db.followUpSnoozes.test.js (Etapa C).
vi.mock('./supabaseClient.js', () => ({ supabase: { from: vi.fn() } }));

const { supabase } = await import('./supabaseClient.js');
const { tasksApi, isAutoStagePendingDuplicate } = await import('./db.js');

// insertAutoStage usa a cadeia .insert().select().single() (nunca
// .maybeSingle() — espera exatamente 0 ou 1 linha, e trata a ausência
// como erro 23505, nunca como "nenhuma linha").
function queuedInsertBuilder(response) {
  const builder = {};
  builder.insert = vi.fn(() => builder);
  builder.select = vi.fn(() => builder);
  builder.single = vi.fn(async () => {
    if (response.throws) throw response.throws;
    return { data: response.data ?? null, error: response.error ?? null };
  });
  return builder;
}

beforeEach(() => {
  supabase.from.mockReset();
});

describe('tasksApi.insertAutoStage — requisito 7 (idempotência via 23505, não erro)', () => {
  test('sucesso: devolve a tarefa inserida, com etapaGatilho mapeada', async () => {
    const row = { id: 'task-1', titulo: 'Preparar e enviar proposta: Lilliane', categoria: 'Follow-up', data: '2026-10-13', horario: null, concluida: false, lead_id: 'lead-1', origem: 'auto_stage', template_id: null, etapa_gatilho: 'Proposta' };
    const builder = queuedInsertBuilder({ data: row });
    supabase.from.mockImplementation(() => builder);

    const result = await tasksApi.insertAutoStage({
      titulo: 'Preparar e enviar proposta: Lilliane', categoria: 'Follow-up', data: '2026-10-13', horario: '', concluida: false, leadId: 'lead-1', origem: 'auto_stage', etapaGatilho: 'Proposta',
    });

    expect(supabase.from).toHaveBeenCalledWith('tasks');
    expect(builder.insert).toHaveBeenCalledWith(expect.objectContaining({ etapa_gatilho: 'Proposta', origem: 'auto_stage', lead_id: 'lead-1' }));
    expect(result).toEqual({ id: 'task-1', titulo: 'Preparar e enviar proposta: Lilliane', categoria: 'Follow-up', data: '2026-10-13', horario: '', concluida: false, leadId: 'lead-1', origem: 'auto_stage', templateId: null, etapaGatilho: 'Proposta' });
  });

  test('corrida (23505 — outra aba/operação já criou a mesma tarefa pendente): devolve null, NUNCA lança', async () => {
    const duplicateError = { code: '23505', message: 'duplicate key value violates unique constraint "tasks_auto_stage_pending_unique_idx"' };
    const builder = queuedInsertBuilder({ error: duplicateError });
    supabase.from.mockImplementation(() => builder);

    const result = await tasksApi.insertAutoStage({
      titulo: 'x', categoria: 'Follow-up', data: '2026-10-13', horario: '', concluida: false, leadId: 'lead-1', origem: 'auto_stage', etapaGatilho: 'Proposta',
    });

    expect(result).toBeNull();
  });

  test('qualquer outro erro (RLS, coluna inexistente se migration 028 não aplicada, rede) propaga normalmente', async () => {
    const permissionError = { code: '42501', message: 'permission denied' };
    const builder = queuedInsertBuilder({ error: permissionError });
    supabase.from.mockImplementation(() => builder);

    await expect(tasksApi.insertAutoStage({
      titulo: 'x', categoria: 'Follow-up', data: '2026-10-13', horario: '', concluida: false, leadId: 'lead-1', origem: 'auto_stage', etapaGatilho: 'Proposta',
    })).rejects.toBe(permissionError);
  });

  // Correção pós-revisão do PR #76 (achado 6) — um 23505 de QUALQUER
  // OUTRA restrição única (ex. a PK, numa corrida de id hipotética)
  // nunca pode ser mascarado como "idempotente" — só o índice
  // específico desta fase deve virar no-op.
  test('23505 de OUTRA restrição única (nome diferente do índice desta fase) propaga normalmente, nunca é tratado como duplicata idempotente', async () => {
    const otherUniqueError = { code: '23505', message: 'duplicate key value violates unique constraint "tasks_pkey"' };
    const builder = queuedInsertBuilder({ error: otherUniqueError });
    supabase.from.mockImplementation(() => builder);

    await expect(tasksApi.insertAutoStage({
      titulo: 'x', categoria: 'Follow-up', data: '2026-10-13', horario: '', concluida: false, leadId: 'lead-1', origem: 'auto_stage', etapaGatilho: 'Proposta',
    })).rejects.toBe(otherUniqueError);
  });
});

describe('isAutoStagePendingDuplicate — reconhecimento específico do índice (achado 6)', () => {
  test('23505 com o nome exato do índice desta fase -> true', () => {
    expect(isAutoStagePendingDuplicate({ code: '23505', message: 'duplicate key value violates unique constraint "tasks_auto_stage_pending_unique_idx"' })).toBe(true);
  });

  test('23505 de outra constraint -> false', () => {
    expect(isAutoStagePendingDuplicate({ code: '23505', message: 'duplicate key value violates unique constraint "tasks_pkey"' })).toBe(false);
  });

  test('código diferente de 23505, mesmo citando o nome do índice -> false', () => {
    expect(isAutoStagePendingDuplicate({ code: '42501', message: 'tasks_auto_stage_pending_unique_idx' })).toBe(false);
  });

  test('erro ausente/malformado -> false, nunca lança', () => {
    expect(isAutoStagePendingDuplicate(null)).toBe(false);
    expect(isAutoStagePendingDuplicate({ code: '23505' })).toBe(false); // sem message
  });
});

describe('taskToRow (via tasksApi.insert) — regressão de compatibilidade (etapa_gatilho nunca enviada por quem não a usa)', () => {
  test('tarefa manual (addTask) nunca inclui a chave etapa_gatilho no payload — compatível mesmo antes da migration 028', async () => {
    const row = { id: 'task-2', titulo: 'Ligar para fornecedor', categoria: 'Operacional', data: '2026-10-12', horario: null, concluida: false, lead_id: null, origem: 'manual', template_id: null };
    const builder = {};
    builder.insert = vi.fn(() => builder);
    builder.select = vi.fn(() => builder);
    builder.single = vi.fn(async () => ({ data: row, error: null }));
    supabase.from.mockImplementation(() => builder);

    await tasksApi.insert({ titulo: 'Ligar para fornecedor', categoria: 'Operacional', data: '2026-10-12', horario: '', concluida: false, leadId: null, origem: 'manual' });

    const payload = builder.insert.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(payload, 'etapa_gatilho')).toBe(false);
  });

  test('tarefa lead-agenda (reconcileLeadAgendaActions) também nunca inclui a chave', async () => {
    const row = { id: 'task-3', titulo: 'Contato: Lilliane', categoria: 'Agenda/Ligação', data: '2026-10-13', horario: '10:00', concluida: false, lead_id: 'lead-1', origem: 'lead-agenda', template_id: null };
    const builder = {};
    builder.insert = vi.fn(() => builder);
    builder.select = vi.fn(() => builder);
    builder.single = vi.fn(async () => ({ data: row, error: null }));
    supabase.from.mockImplementation(() => builder);

    await tasksApi.insert({ titulo: 'Contato: Lilliane', categoria: 'Agenda/Ligação', data: '2026-10-13', horario: '10:00', concluida: false, leadId: 'lead-1', origem: 'lead-agenda' });

    const payload = builder.insert.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(payload, 'etapa_gatilho')).toBe(false);
  });
});

describe('taskToRow (via tasksApi.update) — regressão CRÍTICA do achado 3 (toggle após fetch nunca envia etapa_gatilho)', () => {
  // Este é exatamente o cenário real que quebrava antes da correção:
  // uma tarefa é LIDA do banco (taskFromRow sempre devolve
  // `etapaGatilho: null` ou o valor real, nunca `undefined`) e depois
  // RE-ENVIADA por spread num update comum (toggleTask faz
  // `tasksApi.update(id, { ...t, concluida: !t.concluida })`,
  // useAppState.js). A guard antiga (`!== undefined`) sempre via
  // `etapaGatilho` como presente nesse cenário e incluía
  // `etapa_gatilho` no payload — isto prova que a correção (nunca
  // emitir a coluna via taskToRow) resolve isto para QUALQUER tarefa,
  // auto_stage ou não.
  test('toggle de uma tarefa MANUAL já lida do banco (etapaGatilho: null) nunca inclui etapa_gatilho no payload de update', async () => {
    const taskFromState = tasksApi.fromRow({ id: 't1', titulo: 'Ligar para fornecedor', categoria: 'Operacional', data: '2026-10-12', horario: null, concluida: false, lead_id: null, origem: 'manual', template_id: null });
    expect(taskFromState.etapaGatilho).toBeNull(); // confirma a premissa do cenário

    const row = { ...taskFromState, concluida: true };
    const builder = {};
    builder.update = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.select = vi.fn(() => builder);
    builder.single = vi.fn(async () => ({ data: row, error: null }));
    supabase.from.mockImplementation(() => builder);

    await tasksApi.update('t1', { ...taskFromState, concluida: true });

    const payload = builder.update.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(payload, 'etapa_gatilho')).toBe(false);
  });

  test('toggle de uma tarefa AUTO_STAGE já lida do banco (etapaGatilho preenchida) também nunca inclui etapa_gatilho no payload — o valor já salvo no banco é PRESERVADO (coluna omitida), nunca reenviado/limpo', async () => {
    const taskFromState = tasksApi.fromRow({ id: 't2', titulo: 'Preparar e enviar proposta: Lilliane', categoria: 'Follow-up', data: '2026-10-13', horario: null, concluida: false, lead_id: 'lead-1', origem: 'auto_stage', template_id: null, etapa_gatilho: 'Proposta' });
    expect(taskFromState.etapaGatilho).toBe('Proposta'); // confirma a premissa

    const row = { ...taskFromState, concluida: true };
    const builder = {};
    builder.update = vi.fn(() => builder);
    builder.eq = vi.fn(() => builder);
    builder.select = vi.fn(() => builder);
    builder.single = vi.fn(async () => ({ data: row, error: null }));
    supabase.from.mockImplementation(() => builder);

    await tasksApi.update('t2', { ...taskFromState, concluida: true });

    const payload = builder.update.mock.calls[0][0];
    expect(Object.prototype.hasOwnProperty.call(payload, 'etapa_gatilho')).toBe(false);
  });
});

describe('taskFromRow — leitura de etapa_gatilho (direto, sem passar por insertAutoStage)', () => {
  test('linha com etapa_gatilho preenchida é mapeada para etapaGatilho', () => {
    expect(tasksApi.fromRow({ id: 't1', titulo: 'x', categoria: 'Follow-up', data: '2026-10-13', horario: null, concluida: false, lead_id: 'lead-1', origem: 'auto_stage', template_id: null, etapa_gatilho: 'Proposta' }).etapaGatilho).toBe('Proposta');
  });

  test('linha sem a coluna (migration 028 ainda não aplicada) -> etapaGatilho null, nunca undefined/lança', () => {
    expect(tasksApi.fromRow({ id: 't2', titulo: 'x', categoria: 'Follow-up', data: '2026-10-13', horario: null, concluida: false, lead_id: 'lead-1', origem: 'manual', template_id: null }).etapaGatilho).toBeNull();
  });
});
