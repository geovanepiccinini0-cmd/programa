import { STAGES, LOST_REASONS } from '../constants.js';
import { leadValor, getStaleLeads } from '../utils.js';

// O período filtra a data de cadastro, não a data de fechamento.
// Sem histórico completo de mudanças, os indicadores são uma fotografia
// do estágio ATUAL dos leads captados no intervalo escolhido.
export function buildCommercialDashboard(leads, { period = 'all', product = 'Todos', owner = 'Todos', now = new Date() } = {}) {
  const cutoff = period === 'all' ? null : new Date(now.getTime() - Number(period) * 86400000);
  const scoped = leads.filter((lead) => {
    if (lead.deletedAt) return false;
    if (product !== 'Todos' && lead.produto !== product) return false;
    if (owner !== 'Todos' && (lead.userId || '') !== owner) return false;
    if (!cutoff) return true;
    const created = lead.createdAt || lead.criadoEm;
    if (!created) return false;
    const date = new Date(created);
    return !Number.isNaN(date.getTime()) && date >= cutoff && date <= now;
  });
  const open = scoped.filter((lead) => !['Ganho', 'Perdido'].includes(lead.etapa));
  const won = scoped.filter((lead) => lead.etapa === 'Ganho');
  const lost = scoped.filter((lead) => lead.etapa === 'Perdido');
  const pipeline = open.reduce((sum, lead) => sum + leadValor(lead), 0);
  // Cadastro desatualizado NÃO significa necessariamente falta de contato.
  const staleRegistrations = getStaleLeads(open).length;
  const today = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const overdueNextContact = open.filter((lead) => lead.proximoContato && lead.proximoContato < today).length;
  const negotiations = open.filter((lead) => lead.etapa === 'Negociação').length;
  const byStage = STAGES.map((stage) => ({
    name: stage,
    count: scoped.filter((lead) => lead.etapa === stage).length,
  }));
  const group = (key) => Object.entries(scoped.reduce((acc, lead) => {
    const name = key === 'userId' ? (lead.userId || 'Sem responsável') : (lead[key] || 'Não informado');
    if (!acc[name]) acc[name] = { name, count: 0, won: 0, lost: 0, pipeline: 0 };
    acc[name].count += 1;
    if (lead.etapa === 'Ganho') acc[name].won += 1;
    if (lead.etapa === 'Perdido') acc[name].lost += 1;
    if (!['Ganho', 'Perdido'].includes(lead.etapa)) acc[name].pipeline += leadValor(lead);
    return acc;
  }, Object.create(null))).map(([, value]) => value).sort((a, b) => b.count - a.count);
  const lostReasons = new Map();
  lost.forEach((lead) => {
    const name = LOST_REASONS.find((reason) => reason.value === lead.lostReason)?.label || lead.lostReason || 'Não informado';
    lostReasons.set(name, (lostReasons.get(name) || 0) + 1);
  });
  return {
    total: scoped.length, open: open.length, won: won.length, lost: lost.length,
    pipeline, staleRegistrations, overdueNextContact, negotiations, currentWonRate: scoped.length ? won.length / scoped.length : 0,
    byStage, byOwner: group('userId'), byProduct: group('produto'), byChannel: group('canal'),
    byLostReason: [...lostReasons].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    acquisition: buildAcquisitionTrend(scoped, { cutoff, now }),
  };
}

// Buckets include empty intervals, so an absent day is never drawn as growth.
// Dates outside the valid range are reported separately, never invented.
export function buildAcquisitionTrend(leads, { cutoff = null, now = new Date() } = {}) {
  const dates = leads.map((lead) => new Date(lead.createdAt || lead.criadoEm || NaN))
    .filter((date) => !Number.isNaN(date.getTime()) && date <= now && (!cutoff || date >= cutoff));
  if (!dates.length) return { bins: [], undated: leads.length };
  const first = cutoff || new Date(Math.min(...dates.map(Number)));
  const start = new Date(first.getFullYear(), first.getMonth(), first.getDate());
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const days = Math.max(1, Math.round((end - start) / 86400000));
  const step = Math.max(1, Math.ceil(days / 12));
  const bins = [];
  const format = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', ...(days > 365 ? { year: '2-digit' } : {}) });
  for (let offset = 0; offset < days; offset += step) {
    const from = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    const to = new Date(start.getFullYear(), start.getMonth(), start.getDate() + Math.min(days, offset + step));
    const last = new Date(to.getFullYear(), to.getMonth(), to.getDate() - 1);
    bins.push({ date: from.toISOString(), label: format.format(from), range: step === 1 ? format.format(from) : `${format.format(from)} a ${format.format(last)}`, count: dates.filter((date) => date >= from && date < to).length });
  }
  return { bins, undated: leads.length - dates.length };
}

export function dashboardCSV(rows, { category, period, product, owner, asOf }) {
  const cell = (value) => {
    let text = String(value ?? '');
    if (/^[\s\uFEFF]*[=+@-]/.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const lines = [
    ['Relatório comercial · Painel Piccinini'],
    ['Atualizado em', asOf.toLocaleString('pt-BR')],
    ['Período de cadastro', period], ['Produto', product], ['Responsável', owner],
    ['Critério', 'Etapas atuais dos leads cadastrados no período. Pipeline é crédito/valor do negócio, não receita ou comissão.'],
    [], [category, 'Leads', 'Ganhos', 'Perdidos', 'Pipeline ativo (R$)'],
    ...rows.map((row) => [row.label || row.name, row.count, row.won ?? '', row.lost ?? '', row.pipeline == null ? '' : row.pipeline.toFixed(2).replace('.', ',')]),
  ];
  return '\uFEFF' + lines.map((line) => line.map(cell).join(';')).join('\r\n');
}

