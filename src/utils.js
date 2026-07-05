export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

export function formatPhoneBR(value) {
  const digits = (value || '').replace(/\D/g, '').slice(0, 11);
  const len = digits.length;
  if (len === 0) return '';
  if (len <= 2) return `(${digits}`;
  if (len <= 3) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (len <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2, 3)} ${digits.slice(3)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 3)} ${digits.slice(3, 7)}-${digits.slice(7)}`;
}

export function fmtBRL(n) {
  n = Number(n) || 0;
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}

export function fmtDate(d) {
  if (!d) return '—';
  const [, m, day] = d.split('-');
  return day + '/' + m;
}

export function diasDesde(d) {
  if (!d) return null;
  const then = new Date(d + 'T00:00:00');
  const now = new Date(todayStr() + 'T00:00:00');
  return Math.round((now - then) / 86400000);
}

export function isTaskOverdue(t) {
  if (t.concluida || !t.data) return false;
  const today = todayStr();
  if (t.data < today) return true;
  if (t.data === today && t.horario) {
    const now = new Date();
    const nowHM = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    return t.horario < nowHM;
  }
  return false;
}

export function leadValor(l) {
  if (l.produto === 'Carta Contemplada' || l.produto === 'Consórcio') return Number(l.credito) || 0;
  return Number(l.valor) || 0;
}

export function moneyRaw(str) {
  if (!str) return '';
  let s = str.toString().trim();
  s = s.replace(/,\d{2}$/, '');
  return s.replace(/\D/g, '');
}

export function moneyFormat(str) {
  const digits = moneyRaw(str);
  if (!digits) return '';
  const num = parseInt(digits, 10);
  return num.toLocaleString('pt-BR') + ',00';
}

export function parseMoneyValue(str) {
  const digits = moneyRaw(str);
  return digits ? parseInt(digits, 10) : '';
}

export function csvEscape(v) {
  return `"${String(v === null || v === undefined ? '' : v).replace(/"/g, '""')}"`;
}

export function exportLeadsCSV(leads, produtoFiltro, etapaFiltro) {
  let filtered = leads.slice();
  if (produtoFiltro !== 'Todos') filtered = filtered.filter((l) => l.produto === produtoFiltro);
  if (etapaFiltro !== 'Todos') filtered = filtered.filter((l) => l.etapa === etapaFiltro);
  if (filtered.length === 0) {
    alert('Nenhum lead encontrado com esse filtro.');
    return false;
  }

  const headers = [
    'Nome', 'Telefone', 'Canal', 'Produto', 'Tipo', 'Etapa', 'Valor de Crédito', 'Entrada',
    '% Entrada/Crédito', 'Parcela', 'Lance', 'Valor Estimado', 'Valor de Avaliação do Imóvel',
    '% LTV', 'Próximo Contato', 'Dias sem contato', 'Notas',
  ];
  const rows = filtered.map((l) => {
    const dias = diasDesde(l.ultimaAtualizacao || l.criadoEm);
    const pctEntrada = l.credito > 0 && l.entrada != null ? Math.round((Number(l.entrada) / Number(l.credito)) * 100) : '';
    const ltv = l.valorImovel > 0 && l.valor != null ? Math.round((Number(l.valor) / Number(l.valorImovel)) * 100) : '';
    return [
      l.nome, l.telefone || '', l.canal || '', l.produto || '', l.tipo || '', l.etapa || '',
      l.credito || '', l.entrada || '', pctEntrada, l.parcela || '', l.lance || '', l.valor || '',
      l.valorImovel || '', ltv, l.proximoContato || '', dias !== null ? dias : '', l.notas || '',
    ];
  });
  const csvLines = [headers.map(csvEscape).join(';'), ...rows.map((r) => r.map(csvEscape).join(';'))];
  const csv = '﻿' + csvLines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const sufixo = (produtoFiltro !== 'Todos' ? '-' + produtoFiltro : '') + (etapaFiltro !== 'Todos' ? '-' + etapaFiltro : '');
  a.href = url;
  a.download = `leads${sufixo.replace(/\s+/g, '_')}-${todayStr()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}

export function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
