import { supabase } from './supabaseClient.js';

function leadFromRow(r) {
  return {
    id: r.id,
    nome: r.nome,
    telefone: r.telefone || '',
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
    criadoEm: r.criado_em,
    ultimaAtualizacao: r.ultima_atualizacao,
  };
}

function leadToRow(data) {
  return {
    nome: data.nome,
    telefone: data.telefone,
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
    ...(data.criadoEm ? { criado_em: data.criadoEm } : {}),
    ...(data.ultimaAtualizacao ? { ultima_atualizacao: data.ultimaAtualizacao } : {}),
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

async function fetchAll(table, fromRow) {
  const { data, error } = await supabase.from(table).select('*').order('created_at', { ascending: true });
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
  fetchAll: () => fetchAll('leads', leadFromRow),
  insert: (data) => insertRow('leads', leadToRow, leadFromRow, data),
  update: (id, data) => updateRow('leads', leadToRow, leadFromRow, id, data),
  remove: (id) => deleteRow('leads', id),
  fromRow: leadFromRow,
};

export const tasksApi = {
  fetchAll: () => fetchAll('tasks', taskFromRow),
  insert: (data) => insertRow('tasks', taskToRow, taskFromRow, data),
  update: (id, data) => updateRow('tasks', taskToRow, taskFromRow, id, data),
  remove: (id) => deleteRow('tasks', id),
  fromRow: taskFromRow,
};

export const templatesApi = {
  fetchAll: () => fetchAll('templates', templateFromRow),
  insert: (data) => insertRow('templates', templateToRow, templateFromRow, data),
  update: (id, data) => updateRow('templates', templateToRow, templateFromRow, id, data),
  remove: (id) => deleteRow('templates', id),
  fromRow: templateFromRow,
};
