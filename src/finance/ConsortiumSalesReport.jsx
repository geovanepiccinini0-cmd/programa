import { money, dateLabel, monthOf, exportCSV } from './model.js';
import { Panel, Table, Empty } from './ui.jsx';

export default function ConsortiumSalesReport({ state, month }) {
  const sales = state.sales.filter(s => s.status === 'confirmed' && s.product === 'Consórcio' && monthOf(s.soldAt) === month)
    .sort((a, b) => a.soldAt.localeCompare(b.soldAt) || a.name.localeCompare(b.name));
  const administrator = sale => state.administrators.find(a => a.id === sale.administratorId)?.name || 'Não informada';
  const plan = sale => sale.ruleSnapshot?.plan || sale.plan || 'Não informado';
  const credit = sales.reduce((total, sale) => total + (sale.credit || 0), 0);
  const commission = sales.reduce((total, sale) => total + (sale.gross || 0), 0);
  const headers = ['Cliente / fechamento', 'Crédito vendido', 'Administradora', 'Plano vendido', 'Origem do lead', 'Comissão total'];
  const download = () => exportCSV([
    ['Demonstrativo mensal de consórcios', month],
    ['Cliente', 'Fechamento', 'Crédito vendido', 'Administradora', 'Plano vendido', 'Origem do lead', 'Comissão total'],
    ...sales.map(s => [s.name, dateLabel(s.soldAt), money(s.credit), administrator(s), plan(s), s.channel || 'Não informada', money(s.gross)]),
    ['Total', '', money(credit), '', '', '', money(commission)]
  ], `consorcios-${month}.csv`);
  return <Panel title="Demonstrativo mensal · Consórcios" note="Vendas confirmadas pelo mês de fechamento. Comissão total contratada, somando todas as parcelas previstas da venda." actions={<button onClick={download}>Exportar demonstrativo CSV</button>}>
    <Table headers={headers} foot={<tr><th scope="row">Total · {sales.length} venda(s)</th><td>{money(credit)}</td><td colSpan={3}></td><td>{money(commission)}</td></tr>}>
      {sales.map(s => <tr key={s.id}><th scope="row">{s.name}<small>{dateLabel(s.soldAt)}</small></th><td>{money(s.credit)}</td><td>{administrator(s)}</td><td>{plan(s)}</td><td>{s.channel || 'Não informada'}</td><td>{money(s.gross)}</td></tr>)}
    </Table>
    {!sales.length && <Empty/>}
  </Panel>;
}
