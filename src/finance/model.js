// All money is stored as integer centavos. Dates are local business dates (YYYY-MM-DD).
export const uid = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(n => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};
export const businessDate = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
export const monthOf = (date) => date?.slice(0, 7) || '';
export function cents(value) {
  if (value === '' || value == null || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error('Preencha um valor válido, maior ou igual a zero.');
  const text = String(value);
  if (!/^\d+(\.\d{1,2})?$/.test(text)) throw new Error('Use no máximo duas casas decimais.');
  const [whole, decimal = ''] = text.split('.');
  const result = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result > 1e12) throw new Error('Valor fora do limite permitido.');
  return result;
}
export const money = (value) => value == null ? 'Pendente' : (value / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const dateLabel = (date) => date ? date.split('-').reverse().join('/') : 'Sem data';
export function validDate(date) { const parsed = new Date(`${date}T12:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(date || '') && !Number.isNaN(+parsed) && parsed.toISOString().slice(0, 10) === date; }
export function addMonths(date, offset) {
  if (!validDate(date)) throw new Error('Data inválida.');
  const [year, month, day] = date.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1 + offset, 1));
  const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  return `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}
export const emptyWorkspace = () => ({ schema: 1, administrators: [], rules: [], sales: [], receipts: [], expenses: [], pockets: [], transfers: [], budgets: [], opening: null });
const requireIt = (condition, message) => { if (!condition) throw new Error(message); };
const amountValid = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 1e12;

export function draftFromLead(lead) {
  return { id: `lead-${lead.id}`, leadId: lead.id, name: lead.nome, product: lead.produto, channel: lead.canal || 'Não informado', ownerId: lead.userId || '', credit: Math.round(Number(lead.credito || lead.valor || 0) * 100), soldAt: lead.wonAt ? businessDate(new Date(lead.wonAt)) : '', status: 'draft', officePercent: 50, installments: [], source: 'lead' };
}
export function syncWonLeads(state, leads) {
  const known = new Set(state.sales.map(s => s.leadId));
  const drafts = leads.filter(l => l.etapa === 'Ganho' && !l.deletedAt && !known.has(l.id)).map(draftFromLead);
  return drafts.length ? { ...state, sales: [...state.sales, ...drafts] } : state;
}
export function validateRule(rule) {
  requireIt(rule.administratorId && rule.modality && rule.plan && rule.name?.trim(), 'Informe administradora, modalidade, plano e nome da regra.');
  requireIt(validDate(rule.startsOn) && (!rule.endsOn || (validDate(rule.endsOn) && rule.endsOn >= rule.startsOn)), 'Confira a vigência da regra.');
  requireIt(Number.isInteger(rule.commissionBps) && rule.commissionBps > 0 && rule.commissionBps <= 10000, 'Comissão deve estar entre 0 e 100%.');
  requireIt(Number.isInteger(rule.officeBps) && rule.officeBps >= 0 && rule.officeBps <= 10000, 'Repasse inválido.');
  requireIt(rule.parcels?.length > 0 && rule.parcels.length <= 60, 'Cadastre entre 1 e 60 parcelas.');
  requireIt(rule.parcels.every(p => Number.isInteger(p.offset) && p.offset >= 0 && p.offset <= 120 && Number.isInteger(p.shareBps) && p.shareBps > 0), 'Confira mês e percentual de cada parcela.');
  requireIt(rule.parcels.reduce((sum, p) => sum + p.shareBps, 0) === 10000, 'A distribuição das parcelas deve somar 100%.');
  requireIt(new Set(rule.parcels.map(p => p.offset)).size === rule.parcels.length, 'Não repita o mês da parcela.');
}
export function saleAmounts(sale) {
  if (sale.status !== 'confirmed') return { gross: null, office: null, own: null };
  return { gross: sale.gross, office: sale.office, own: sale.own };
}
export const netPaid = (state, saleId, installmentId) => state.receipts.filter(r => r.saleId === saleId && (!installmentId || r.installmentId === installmentId)).reduce((sum, r) => sum + (r.type === 'refund' ? -r.amount : r.amount), 0);
export function confirmSale(input, state) {
  const sale = { ...input };
  requireIt(sale.name?.trim() && validDate(sale.soldAt) && validDate(sale.firstDue), 'Informe cliente, fechamento e primeiro recebimento.');
  requireIt(amountValid(sale.credit), 'Informe o crédito contratado.');
  const previous = state.sales.find(s => s.id === sale.id);
  requireIt(previous?.status !== 'cancelled', 'Venda cancelada permanece no histórico. Registre uma nova oportunidade para outra venda.');
  requireIt(!state.receipts.some(r => r.saleId === sale.id), 'Venda com movimentos financeiros: mantenha as condições históricas. Cancele/estorne pelo Financeiro.');
  let parcels;
  if (sale.product === 'Carta Contemplada') {
    requireIt(amountValid(sale.saleValue) && amountValid(sale.costValue), 'Informe venda e custo da cota. Zero deve ser informado explicitamente.');
    requireIt(sale.saleValue >= sale.costValue, 'Venda abaixo do custo: revise os valores.');
    requireIt([50, 60].includes(sale.officePercent), 'Selecione 50/50 ou 60/40.');
    sale.gross = sale.saleValue - sale.costValue;
    sale.office = Math.round(sale.gross * sale.officePercent / 100);
    sale.own = sale.gross - sale.office;
    parcels = [{ offset: 0, shareBps: 10000 }];
    sale.ruleSnapshot = null;
  } else if (sale.product === 'Consórcio') {
    const rule = state.rules.find(r => r.id === sale.ruleId);
    requireIt(rule && rule.active && rule.administratorId === sale.administratorId && rule.modality === sale.modality && rule.plan === sale.plan, 'Selecione uma regra ativa para administradora, modalidade e plano.');
    validateRule(rule);
    requireIt(state.administrators.some(a => a.id === rule.administratorId && a.active), 'Administradora inativa.');
    requireIt(sale.soldAt >= rule.startsOn && (!rule.endsOn || sale.soldAt <= rule.endsOn), 'Regra fora da vigência na data de fechamento.');
    sale.gross = Math.round(sale.credit * rule.commissionBps / 10000);
    sale.office = Math.round(sale.gross * rule.officeBps / 10000);
    sale.own = sale.gross - sale.office;
    sale.ruleSnapshot = structuredClone(rule);
    parcels = [...rule.parcels].sort((a, b) => a.offset - b.offset);
  } else throw new Error('Comissionamento disponível nesta entrega para Consórcio e Carta Contemplada.');
  let distributed = 0;
  sale.installments = parcels.map((p, index) => {
    const amount = index === parcels.length - 1 ? sale.own - distributed : Math.round(sale.own * p.shareBps / 10000);
    distributed += amount;
    return { id: `${sale.id}-${index}`, number: index + 1, due: addMonths(sale.firstDue, p.offset), amount };
  });
  requireIt(sale.installments.every(p => p.amount >= 0), 'Distribuição não comporta o valor da comissão.');
  return { ...sale, status: 'confirmed', confirmedAt: previous?.confirmedAt || new Date().toISOString() };
}
export function receive(state, input) {
  const sale = state.sales.find(s => s.id === input.saleId && s.status === 'confirmed');
  const installment = sale?.installments.find(p => p.id === input.installmentId);
  requireIt(installment && validDate(input.date) && input.date <= businessDate(), 'Selecione uma parcela e uma data efetiva até hoje.');
  requireIt(!state.opening || input.date >= state.opening.date, 'Movimento anterior ao saldo inicial. Ajuste o saldo inicial antes de lançar.');
  requireIt(amountValid(input.amount) && input.amount > 0, 'Informe um recebimento maior que zero.');
  requireIt(input.amount <= installment.amount - netPaid(state, sale.id, installment.id), 'Valor supera o saldo da parcela.');
  return { ...state, receipts: [...state.receipts, { ...input, id: uid(), type: 'receipt', recordedAt: new Date().toISOString() }] };
}
export function refundReceipt(state, input) {
  const receipt = state.receipts.find(r => r.id === input.receiptId && r.type === 'receipt');
  requireIt(receipt && validDate(input.date) && input.date >= receipt.date && input.date <= businessDate() && input.reason?.trim(), 'Informe recebimento, data de devolução e motivo.');
  requireIt(amountValid(input.amount) && input.amount > 0, 'Valor de devolução inválido.');
  const refunded = state.receipts.filter(r => r.receiptId === receipt.id).reduce((sum, r) => sum + r.amount, 0);
  requireIt(input.amount <= receipt.amount - refunded, 'Devolução supera o recebido.');
  return { ...state, receipts: [...state.receipts, { ...input, id: uid(), saleId: receipt.saleId, installmentId: receipt.installmentId, type: 'refund', recordedAt: new Date().toISOString() }] };
}
export function cancelSale(state, id, reason) {
  requireIt(reason?.trim(), 'Informe o motivo do cancelamento.');
  requireIt(netPaid(state, id) === 0, 'Registre a devolução dos recebimentos antes de cancelar.');
  return { ...state, sales: state.sales.map(s => s.id === id ? { ...s, status: 'cancelled', cancelReason: reason, cancelledAt: new Date().toISOString() } : s) };
}
export function installments(state) {
  return state.sales.filter(s => s.status === 'confirmed').flatMap(s => s.installments.map(p => ({ ...p, sale: s, paid: netPaid(state, s.id, p.id), balance: p.amount - netPaid(state, s.id, p.id) })));
}
export function mapMonths(state, startMonth, length = 6, product = 'Todos') {
  const months = Array.from({ length }, (_, i) => monthOf(addMonths(`${startMonth}-01`, i)));
  const rows = state.sales.filter(s => s.status === 'confirmed' && (product === 'Todos' || s.product === product)).map(sale => ({
    sale, cells: months.map(month => {
      const ps = installments(state).filter(p => p.sale.id === sale.id && monthOf(p.due) === month);
      return { expected: ps.reduce((n, p) => n + p.amount, 0), paid: ps.reduce((n, p) => n + p.paid, 0), balance: ps.reduce((n, p) => n + p.balance, 0) };
    }),
  }));
  return { months, rows, totals: months.map((_, i) => rows.reduce((sum, r) => ({ expected: sum.expected + r.cells[i].expected, paid: sum.paid + r.cells[i].paid, balance: sum.balance + r.cells[i].balance }), { expected: 0, paid: 0, balance: 0 })) };
}
export function pocketBalance(state, pocketId) {
  return state.transfers.filter(t => t.pocketId === pocketId).reduce((n, t) => n + (t.type === 'in' ? t.amount : -t.amount), 0)
    - state.expenses.filter(e => e.pocketId === pocketId && e.paidAt).reduce((n, e) => n + e.amount, 0);
}
export function cash(state, asOf = businessDate()) {
  const from = state.opening?.date || '0000-01-01';
  const received = state.receipts.filter(r => r.date >= from && r.date <= asOf).reduce((n, r) => n + (r.type === 'refund' ? -r.amount : r.amount), 0);
  const spent = state.expenses.filter(e => e.paidAt && e.paidAt >= from && e.paidAt <= asOf).reduce((n, e) => n + e.amount, 0);
  const reserved = state.pockets.reduce((n, p) => n + pocketBalance(state, p.id), 0);
  const obligations = state.expenses.filter(e => !e.paidAt).reduce((n, e) => n + e.amount, 0);
  const uncovered = state.expenses.filter(e => !e.paidAt && !e.pocketId).reduce((n, e) => n + e.amount, 0)
    + state.pockets.reduce((n, p) => n + Math.max(0, state.expenses.filter(e => !e.paidAt && e.pocketId === p.id).reduce((a, e) => a + e.amount, 0) - pocketBalance(state, p.id)), 0);
  const balance = (state.opening && state.opening.date <= asOf ? state.opening.amount : 0) + received - spent;
  return { received, spent, balance, reserved, obligations, available: balance - reserved - uncovered, initialized: !!state.opening };
}
export function transferPocket(state, input) {
  requireIt(state.pockets.some(p => p.id === input.pocketId) && ['in', 'out'].includes(input.type), 'Caixinha inválida.');
  requireIt(amountValid(input.amount) && input.amount > 0 && validDate(input.date) && input.date <= businessDate(), 'Valor ou data da destinação inválidos.');
  requireIt(state.opening && input.date >= state.opening.date, 'Informe um saldo inicial antes de confirmar destinações.');
  requireIt(input.type === 'in' ? input.amount <= cash(state).available : input.amount <= pocketBalance(state, input.pocketId), 'Saldo insuficiente para essa destinação.');
  return { ...state, transfers: [...state.transfers, { ...input, id: uid(), recordedAt: new Date().toISOString() }] };
}
export function addExpense(state, input) {
  requireIt(input.title?.trim() && input.category && amountValid(input.amount) && input.amount > 0 && validDate(input.due), 'Informe descrição, categoria, valor e vencimento.');
  requireIt(!input.pocketId || state.pockets.some(p => p.id === input.pocketId), 'Caixinha não encontrada.');
  return { ...state, expenses: [...state.expenses, { ...input, id: uid(), paidAt: null }] };
}
export function payExpense(state, id, date) {
  const expense = state.expenses.find(e => e.id === id && !e.paidAt);
  requireIt(expense && validDate(date) && date <= businessDate(), 'Despesa ou data inválida.');
  requireIt(state.opening && date >= state.opening.date, 'Informe o saldo inicial antes de pagar despesas.');
  requireIt(expense.amount <= cash(state).balance - cash(state).reserved + (expense.pocketId ? pocketBalance(state, expense.pocketId) : 0), 'Saldo insuficiente.');
  requireIt(!expense.pocketId || pocketBalance(state, expense.pocketId) >= expense.amount, 'Saldo insuficiente na caixinha.');
  return { ...state, expenses: state.expenses.map(e => e.id === id ? { ...e, paidAt: date } : e) };
}
export function forecast(state, startMonth, count = 6) {
  const today = businessDate();
  const current = cash(state, today);
  let balance = current.balance;
  const rows = Array.from({ length: count }, (_, i) => monthOf(addMonths(`${startMonth}-01`, i))).map(month => {
    const expected = installments(state).filter(p => monthOf(p.due) === month && p.due >= today).reduce((n, p) => n + p.balance, 0);
    const out = state.expenses.filter(e => !e.paidAt && monthOf(e.due) === month && e.due >= today).reduce((n, e) => n + e.amount, 0);
    balance += expected - out;
    return { month, expected, out, balance };
  });
  return { current, rows, overdueIn: installments(state).filter(p => p.due < today).reduce((n, p) => n + p.balance, 0), overdueOut: state.expenses.filter(e => !e.paidAt && e.due < today).reduce((n, e) => n + e.amount, 0) };
}
export function channelResults(state, month) {
  const channels = [...new Set([...state.sales.map(s => s.channel || 'Não informado'), ...state.expenses.filter(e => e.channel).map(e => e.channel)])];
  return channels.map(channel => {
    const sales = state.sales.filter(s => s.status === 'confirmed' && s.channel === channel && monthOf(s.soldAt) === month);
    const spent = state.expenses.filter(e => e.channel === channel && e.paidAt && monthOf(e.paidAt) === month).reduce((n, e) => n + e.amount, 0);
    const received = state.receipts.filter(r => monthOf(r.date) === month && state.sales.find(s => s.id === r.saleId)?.channel === channel).reduce((n, r) => n + (r.type === 'refund' ? -r.amount : r.amount), 0);
    return { channel, count: sales.length, credit: sales.filter(s => s.product === 'Consórcio').reduce((n, s) => n + s.credit, 0), own: sales.reduce((n, s) => n + s.own, 0), received, spent };
  });
}
export function exportCSV(rows, filename) {
  const quote = value => { let v = String(value ?? ''); if (/^[\s]*[=+@-]/.test(v)) v = "'" + v; return '"' + v.replaceAll('"', '""') + '"'; };
  const blob = new Blob(['\uFEFF' + rows.map(r => r.map(quote).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}
