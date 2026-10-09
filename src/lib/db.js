import { supabase } from './supabaseClient.js';
import { normalizePhoneIdentity } from './phoneIdentity.js';
import { whatsappMessageFromRow } from './whatsappMessages.js';
import { conversationOperationalStateFromRow } from './conversationOperationalState.js';

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

  // Upsert manual — cobre tanto o caso "conversa ainda sem nenhum
  // evento automático registrado" (nenhuma linha existe ainda) quanto
  // a alteração normal de uma linha já existente. `user_id` nunca é
  // enviado aqui — o trigger da migration 024 sempre o deriva de
  // leads.user_id, nunca confia no client.
  setStatus: async (leadId, status) => {
    const { data, error } = await supabase
      .from('whatsapp_conversation_state')
      .upsert({ lead_id: leadId, status }, { onConflict: 'lead_id' })
      .select()
      .maybeSingle();
    if (error) throw error;
    return conversationOperationalStateFromRow(data);
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
