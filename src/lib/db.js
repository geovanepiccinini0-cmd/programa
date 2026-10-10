import { supabase } from './supabaseClient.js';
import { normalizePhoneIdentity } from './phoneIdentity.js';
import { whatsappMessageFromRow } from './whatsappMessages.js';
import { conversationOperationalStateFromRow, isConversationStateUniqueViolation } from './conversationOperationalState.js';

function leadFromRow(r) {
  return {
    id: r.id,
    userId: r.user_id,
    nome: r.nome,
    telefone: r.telefone || '',
    cidade: r.cidade || '',
    canal: r.canal || '',
    produto: r.produto,
    etapa: r.etapa,
    tipo: r.tipo,
    credito: r.credito,
    entrada: r.entrada,
    parcela: r.parcela,
    lance: r.lance,
    valor: r.valor,
    valorImovel: r.valor_imovel,
    proximoContato: r.proximo_contato,
    proximoContatoHorario: r.proximo_contato_horario || '',
    notas: r.notas || '',
    tags: r.tags || [],
    criadoEm: r.criado_em,
    ultimaAtualizacao: r.ultima_atualizacao,
    createdAt: r.created_at,
    nextActionType: r.next_action_type || '',
    nextActionNote: r.next_action_note || '',
    leadTemperature: r.lead_temperature || '',
    priority: r.priority || 'normal',
    lostReason: r.lost_reason || '',
    lostReasonNote: r.lost_reason_note || '',
    wonAt: r.won_at,
    lostAt: r.lost_at,
    deletedAt: r.deleted_at,
  };
}

// Fase 3.1.4.1 — phone_normalized (identidade telefônica, src/lib/
// phoneIdentity.js) é SEMPRE derivado de telefone aqui, nunca aceito
// como campo de entrada — mesmo que `data` contenha phone_normalized/
// phoneNormalized (ex. backup antigo, payload externo malformado),
// esses nomes nunca são lidos: a allowlist abaixo não os menciona, e a
// única origem permitida é normalizePhoneIdentity(data.telefone).
//
// Guard de presença de propriedade (não `!== undefined`): precisamos
// distinguir "telefone ausente do payload" (update parcial que não
// pretende tocar o telefone — phone_normalized deve ficar FORA do row
// retornado, para o Postgres não tocar a coluna) de "telefone presente
// e vazio/null/undefined explícito" (o caller está de fato dizendo que
// não há telefone — phone_normalized deve ir como null). Isso cobre
// null/''/qualquer INVALID/AMBIGUOUS, sempre com o mesmo contrato.
//
// Fail-closed deliberado: nenhum try/catch aqui. Se
// normalizePhoneIdentity lançar de forma inesperada, leadToRow lança
// também, e insertRow/updateRow nunca chegam a chamar o Supabase —
// nunca um telefone novo é persistido junto de uma identidade
// stale/incorreta.
// Exportada (Fase 3.1.4.1), mesmo padrão já usado para interactionToRow
// (Fase 2A.1.1) — só para cobertura de teste da fronteira de
// serialização, implementação inalterada.
export function leadToRow(data) {
  return {
    nome: data.nome,
    telefone: data.telefone,
    ...(Object.prototype.hasOwnProperty.call(data, 'telefone')
      ? { phone_normalized: normalizePhoneIdentity(data.telefone).number }
      : {}),
    cidade: data.cidade,
    canal: data.canal,
    produto: data.produto,
    etapa: data.etapa,
    tipo: data.tipo,
    credito: data.credito === '' ? null : data.credito,
    entrada: data.entrada === '' ? null : data.entrada,
    parcela: data.parcela === '' ? null : data.parcela,
    lance: data.lance === '' ? null : data.lance,
    valor: data.valor === '' ? null : data.valor,
    valor_imovel: data.valorImovel === '' ? null : data.valorImovel,
    proximo_contato: data.proximoContato || null,
    proximo_contato_horario: data.proximoContatoHorario || null,
    notas: data.notas,
    tags: data.tags || [],
    ...(data.criadoEm ? { criado_em: data.criadoEm } : {}),
    ...(data.ultimaAtualizacao ? { ultima_atualizacao: data.ultimaAtualizacao } : {}),
    next_action_type: data.nextActionType || null,
    next_action_note: data.nextActionNote || null,
    lead_temperature: data.leadTemperature || null,
    priority: data.priority || 'normal',
    lost_reason: data.lostReason || null,
    lost_reason_note: data.lostReasonNote || null,
    ...(data.wonAt !== undefined ? { won_at: data.wonAt || null } : {}),
    ...(data.lostAt !== undefined ? { lost_at: data.lostAt || null } : {}),
  };
}

function taskFromRow(r) {
  return {
    id: r.id,
    titulo: r.titulo,
    categoria: r.categoria,
    data: r.data,
    horario: r.horario || '',
    concluida: r.concluida,
    leadId: r.lead_id,
    origem: r.origem,
    templateId: r.template_id,
  };
}

function taskToRow(data) {
  return {
    titulo: data.titulo,
    categoria: data.categoria,
    data: data.data || null,
    horario: data.horario || null,
    concluida: !!data.concluida,
    lead_id: data.leadId || null,
    origem: data.origem,
    template_id: data.templateId || null,
  };
}

// Exportadas (Fase 2A.1.1) só para cobertura de teste do limite de
// serialização com o Supabase — implementação inalterada.
export function interactionFromRow(r) {
  return {
    id: r.id,
    leadId: r.lead_id,
    type: r.type,
    direction: r.direction || '',
    channel: r.channel || '',
    content: r.content || '',
    metadata: r.metadata || null,
    occurredAt: r.occurred_at,
    createdAt: r.created_at,
    createdBy: r.created_by || null,
  };
}

export function interactionToRow(data) {
  return {
    lead_id: data.leadId,
    type: data.type,
    direction: data.direction || null,
    channel: data.channel || null,
    content: data.content || null,
    metadata: data.metadata || null,
    created_by: data.createdBy || null,
    ...(data.occurredAt ? { occurred_at: data.occurredAt } : {}),
  };
}

function auditLogToRow(data) {
  return {
    entity_type: data.entityType,
    entity_id: data.entityId,
    action: data.action,
    old_data: data.oldData || null,
    new_data: data.newData || null,
  };
}

function templateFromRow(r) {
  return {
    id: r.id,
    titulo: r.titulo,
    categoria: r.categoria,
    horario: r.horario || '',
    dias: r.dias || [],
    ativo: r.ativo,
  };
}

function templateToRow(data) {
  return {
    titulo: data.titulo,
    categoria: data.categoria,
    horario: data.horario || null,
    dias: data.dias,
    ativo: !!data.ativo,
  };
}

async function fetchAll(table, fromRow, userId) {
  let query = supabase.from(table).select('*').order('created_at', { ascending: true });
  if (userId) query = query.eq('user_id', userId);
  const { data, error } = await query;
  if (error) throw error;
  return data.map(fromRow);
}

async function insertRow(table, toRow, fromRow, data) {
  const { data: rows, error } = await supabase.from(table).insert(toRow(data)).select().single();
  if (error) throw error;
  return fromRow(rows);
}

async function updateRow(table, toRow, fromRow, id, data) {
  const { data: rows, error } = await supabase.from(table).update(toRow(data)).eq('id', id).select().single();
  if (error) throw error;
  return fromRow(rows);
}

async function deleteRow(table, id) {
  const { error } = await supabase.from(table).delete().eq('id', id);
  if (error) throw error;
}

export const leadsApi = {
  fetchAll: (userId) => fetchAll('leads', leadFromRow, userId),
  fetchAllForAdmin: () => fetchAll('leads', leadFromRow),
  insert: (data) => insertRow('leads', leadToRow, leadFromRow, data),
  update: (id, data) => updateRow('leads', leadToRow, leadFromRow, id, data),
  remove: (id) => deleteRow('leads', id),
  fromRow: leadFromRow,
};

export const tasksApi = {
  fetchAll: (userId) => fetchAll('tasks', taskFromRow, userId),
  insert: (data) => insertRow('tasks', taskToRow, taskFromRow, data),
  update: (id, data) => updateRow('tasks', taskToRow, taskFromRow, id, data),
  remove: (id) => deleteRow('tasks', id),
  fromRow: taskFromRow,
};

export const templatesApi = {
  fetchAll: (userId) => fetchAll('templates', templateFromRow, userId),
  insert: (data) => insertRow('templates', templateToRow, templateFromRow, data),
  update: (id, data) => updateRow('templates', templateToRow, templateFromRow, id, data),
  remove: (id) => deleteRow('templates', id),
  fromRow: templateFromRow,
};

export const interactionsApi = {
  fetchForLead: async (leadId) => {
    const { data, error } = await supabase
      .from('lead_interactions')
      .select('*')
      .eq('lead_id', leadId)
      .order('occurred_at', { ascending: false });
    if (error) throw error;
    return data.map(interactionFromRow);
  },
  fetchAllForUser: (userId) => fetchAll('lead_interactions', interactionFromRow, userId),
  insert: (data) => insertRow('lead_interactions', interactionToRow, interactionFromRow, data),
  fromRow: interactionFromRow,
};

export const auditLogApi = {
  insert: async (data) => {
    const { error } = await supabase.from('audit_log').insert(auditLogToRow(data));
    if (error) throw error;
  },
};

// Fase 3.5.1 — Caixa de entrada WhatsApp, SOMENTE LEITURA.
//
// Zero INSERT/UPDATE/DELETE aqui de propósito: esta fase não implementa
// envio nem qualquer escrita em public.whatsapp_messages pelo
// navegador — toda escrita continua exclusiva da RPC
// process_inbound_whatsapp_event (migrations 018/019, service_role),
// nunca alcançável pela sessão autenticada do usuário (RLS só tem
// policies de SELECT para dono/admin — ver migration 018). As queries
// abaixo usam a sessão autenticada normal (o mesmo `supabase` client
// de src/lib/supabaseClient.js, anon key); a segurança real vem da RLS
// no banco, nunca do filtro `.eq('user_id', userId)` adicionado aqui
// (esse filtro é só otimização de índice — removê-lo não abriria
// nenhum acesso extra, porque a RLS já restringe as linhas visíveis).
export const whatsappMessagesApi = {
  fromRow: whatsappMessageFromRow,

  // Janela recente de mensagens do usuário autenticado, para montar a
  // lista de conversas por agrupamento client-side (buildConversationSummaries,
  // src/lib/whatsappMessages.js) — nunca o histórico inteiro de uma vez.
  //
  // Fase 3.5.1 — correção do finding HIGH: ordenação por
  // (occurred_at DESC, id DESC) — occurred_at tem granularidade de
  // SEGUNDO (mensagens do mesmo lead no mesmo segundo são plausíveis);
  // sem um tiebreaker determinístico, a MESMA consulta poderia truncar
  // o `limit` em pontos diferentes entre execuções quando há empate.
  // `id` nunca decide SIGNIFICADO nenhum (não é usado como timestamp),
  // só garante ordem estável.
  fetchRecentForUser: async (userId, limit) => {
    let query = supabase
      .from('whatsapp_messages')
      .select('*')
      .order('occurred_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query;
    if (error) throw error;
    return data.map(whatsappMessageFromRow);
  },

  // Uma página do histórico de UM lead, mais recentes primeiro
  // (invertida para ordem cronológica pelo chamador/mergeOlderPage).
  //
  // Fase 3.5.1 — correção do finding HIGH (cursor composto): o cursor
  // de paginação agora é o PAR (beforeOccurredAt, beforeId) — nunca só
  // o timestamp. Um cursor baseado só em `occurred_at` com `.lt()`
  // estrito EXCLUI PERMANENTEMENTE qualquer mensagem que compartilhe o
  // timestamp exato da borda da página anterior (occurred_at é
  // granularidade de segundo — colisão plausível). O filtro composto
  // replica exatamente a semântica de keyset pagination sobre
  // (occurred_at, id) DESC: ocurred_at estritamente menor, OU
  // occurred_at igual com id estritamente menor — nunca pula uma linha
  // cujo par (occurred_at, id) seja único por construção (id é chave
  // primária).
  fetchPageForLead: async (leadId, { beforeOccurredAt, beforeId, limit } = {}) => {
    let query = supabase
      .from('whatsapp_messages')
      .select('*')
      .eq('lead_id', leadId)
      .order('occurred_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit);
    if (beforeOccurredAt && beforeId) {
      query = query.or(`occurred_at.lt.${beforeOccurredAt},and(occurred_at.eq.${beforeOccurredAt},id.lt.${beforeId})`);
    } else if (beforeOccurredAt) {
      // Defensivo: nunca deveria ocorrer (o chamador sempre passa os
      // dois juntos — ver useWhatsAppInbox.js), mas nunca aplicar um
      // cursor incompleto/inconsistente sem o tiebreaker.
      query = query.lt('occurred_at', beforeOccurredAt);
    }
    const { data, error } = await query;
    if (error) throw error;
    return data.map(whatsappMessageFromRow);
  },
};

// Fase 3.6.2 — Estados operacionais de atendimento (migration 024).
// Leitura/escrita SEMPRE com a sessão autenticada do usuário (mesmo
// client de src/lib/supabaseClient.js, anon key); a segurança real é
// a RLS de whatsapp_conversation_state (dono do lead pode ler/criar/
// atualizar; admin lê/atualiza tudo; nunca DELETE). Alteração manual
// do status é um UPDATE direto permitido pela RLS — nunca uma RPC
// (as transições AUTOMÁTICAS, essas sim via RPC service_role, vivem
// exclusivamente nas Edge Functions, nunca aqui).
export const conversationStateApi = {
  fromRow: conversationOperationalStateFromRow,

  fetchForLead: async (leadId) => {
    const { data, error } = await supabase
      .from('whatsapp_conversation_state')
      .select('*')
      .eq('lead_id', leadId)
      .maybeSingle();
    if (error) throw error;
    return conversationOperationalStateFromRow(data);
  },

  // Fase 3.6.4 — fetch EM LOTE para a lista inteira de conversas
  // (filtro/priorização por estado operacional). Uma única consulta
  // `.in('lead_id', ...)`, nunca N chamadas por conversa — mesmo
  // princípio de fetchUnreadCounts. Escopo é SEMPRE o conjunto de
  // leadIds que o chamador já tem carregado (useWhatsAppInbox deriva
  // de `conversations`, já limitado pela paginação/janela da 3.5.1) —
  // nunca uma varredura solta de toda a tabela. Segurança continua
  // sendo a RLS da 024 ("dono pode ler") — este método nunca decide
  // autorização, só devolve o que a RLS já deixa passar para os ids
  // pedidos. Devolve só as linhas que EXISTEM — leadIds sem nenhuma
  // linha simplesmente não aparecem no array; é responsabilidade do
  // chamador (buildConversationOperationalStatesMap,
  // conversationOperationalState.js) decidir o valor default para
  // esses, nunca deste método, que nunca inventa dados.
  fetchForLeads: async (leadIds) => {
    const ids = Array.from(new Set((leadIds || []).filter(Boolean)));
    if (ids.length === 0) return [];
    const { data, error } = await supabase
      .from('whatsapp_conversation_state')
      .select('*')
      .in('lead_id', ids);
    if (error) throw error;
    return (data || []).map(conversationOperationalStateFromRow);
  },

  // HOTFIX pós-incidente em produção — cobre tanto o caso "conversa
  // ainda sem nenhum evento automático registrado" (nenhuma linha
  // existe ainda) quanto a alteração normal de uma linha já
  // existente. `user_id` nunca é enviado aqui — o trigger da
  // migration 024 sempre o deriva de leads.user_id, nunca confia no
  // client.
  //
  // NUNCA MAIS UM .upsert(...): o upsert anterior gerava, via
  // PostgREST, um `INSERT ... ON CONFLICT (lead_id) DO UPDATE SET
  // lead_id = excluded.lead_id, status = excluded.status` —
  // resolution=merge-duplicates inclui a PRÓPRIA coluna de conflito
  // (`lead_id`) no SET, não só `status`. A migration 025 (seção D)
  // só concede `UPDATE(status)` a `authenticated` — nunca
  // `UPDATE(lead_id)` (deliberado, para impedir escrita direta de
  // last_read_at por esse mesmo caminho) — então QUALQUER chamada
  // cujo upsert caísse no ramo ON CONFLICT (ou seja, toda conversa
  // que já tivesse uma linha — a imensa maioria, já que a RPC
  // automática cria uma linha a cada mensagem) falhava com 42501
  // "permission denied for table whatsapp_conversation_state".
  // Reproduzido empiricamente em Postgres local com os GRANTs exatos
  // da 025 antes desta correção.
  //
  // Correção: dois passos, cada um uma operação SQL simples (sem ON
  // CONFLICT) que cabe inteiramente nos GRANTs de coluna já
  // concedidos (`insert(lead_id, status)` / `update(status)`,
  // migration 025 seção D) — SEM nenhuma migration nova, sem
  // alterar RLS, sem conceder nenhum privilégio adicional:
  //   1. tenta UPDATE (cobre o caso comum — a linha já existe).
  //   2. 0 linhas afetadas (conversa ainda sem nenhuma linha) ->
  //      tenta INSERT.
  //   3. corrida rara entre os passos 1 e 2 (ex. a RPC automática do
  //      service_role cria a linha nesse intervalo exato) -> o
  //      INSERT falha com unique_violation (23505, PK de lead_id) —
  //      nunca propagado como erro: repete o UPDATE uma única vez
  //      (a linha concorrente já existe agora).
  setStatus: async (leadId, status) => {
    const { data: updated, error: updateError } = await supabase
      .from('whatsapp_conversation_state')
      .update({ status })
      .eq('lead_id', leadId)
      .select()
      .maybeSingle();
    if (updateError) throw updateError;
    if (updated) return conversationOperationalStateFromRow(updated);

    const { data: inserted, error: insertError } = await supabase
      .from('whatsapp_conversation_state')
      .insert({ lead_id: leadId, status })
      .select()
      .maybeSingle();
    if (!insertError) return conversationOperationalStateFromRow(inserted);
    if (!isConversationStateUniqueViolation(insertError)) throw insertError;

    const { data: retried, error: retryError } = await supabase
      .from('whatsapp_conversation_state')
      .update({ status })
      .eq('lead_id', leadId)
      .select()
      .maybeSingle();
    if (retryError) throw retryError;
    return conversationOperationalStateFromRow(retried);
  },

  // Fase 3.6.3 (correção pós-revisão do PR #70, achado CONFIRMED) —
  // marca a conversa como lida AGORA usando o relógio do SERVIDOR,
  // nunca o do navegador (um relógio de cliente divergente, uma
  // mensagem/requisição atrasada em voo, ou duas abas do mesmo
  // atendente poderiam gravar um timestamp errado ou retroceder uma
  // leitura mais recente). Via RPC mark_whatsapp_conversation_read
  // (migration 025, seção C) — nunca mais um upsert direto com
  // timestamp local. A função já garante no servidor que
  // last_read_at nunca regride (guarda no ON CONFLICT). 0 linhas
  // devolvidas é o resultado ESPERADO de uma chamada atrasada que
  // perdeu a corrida para uma leitura mais recente — nunca tratado
  // como erro aqui (o chamador não precisa reconciliar nada: o
  // servidor já está com um valor igual ou mais novo).
  markRead: async (leadId) => {
    const { data, error } = await supabase.rpc('mark_whatsapp_conversation_read', { p_lead_id: leadId });
    if (error) throw error;
    return data; // timestamp (string) do servidor, ou null se a chamada perdeu a corrida.
  },

  // Fase 3.6.3 — contagem agregada de não lidas por conversa, para
  // todas as conversas do usuário autenticado (whatsapp_unread_counts(),
  // migration 025) — uma única chamada, nunca N consultas por
  // conversa.
  fetchUnreadCounts: async () => {
    const { data, error } = await supabase.rpc('whatsapp_unread_counts');
    if (error) throw error;
    return (data || []).map((r) => ({ leadId: r.lead_id, unreadCount: r.unread_count }));
  },
};

export const profilesApi = {
  fetchMine: async (userId) => {
    const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error) throw error;
    return data ? { id: data.id, email: data.email, isAdmin: data.is_admin } : null;
  },
  fetchAll: async () => {
    const { data, error } = await supabase.from('profiles').select('*');
    if (error) throw error;
    return data.map((r) => ({ id: r.id, email: r.email, isAdmin: r.is_admin }));
  },
};
