import { useState } from 'react';
import { cents, money, netPaid, dateLabel } from './model.js';
import { Amount, Panel, Table, Empty } from './ui.jsx';

const fields = [
  ['customerDeposit', 'Sinal recebido do cliente'],
  ['partnerDeposit', 'Sinal repassado ao parceiro'],
  ['customerBalancePaid', 'Complemento recebido do cliente'],
  ['partnerBalancePaid', 'Complemento repassado ao parceiro'],
];

export function validateSettlement(sale, values) {
  if (!values) return;
  const received = values.customerDeposit + values.customerBalancePaid;
  const transferred = values.partnerDeposit + values.partnerBalancePaid;
  if (sale.saleValue != null && received > sale.saleValue) {
    throw new Error('O total recebido do cliente supera o valor da venda.');
  }
  if (sale.costValue != null && transferred > sale.costValue) {
    throw new Error('O total repassado ao parceiro supera o custo da cota.');
  }
}

function balances(sale, values) {
  const received = values.customerDeposit + values.customerBalancePaid;
  const transferred = values.partnerDeposit + values.partnerBalancePaid;
  return {
    received,
    transferred,
    customerDue: sale.saleValue == null ? null : sale.saleValue - received,
    partnerDue: sale.costValue == null ? null : sale.costValue - transferred,
    held: received - transferred,
  };
}

export function SettlementEditor({ sale, state, commit, run, saving }) {
  const saved = state.contemplatedSettlements?.[sale.id];
  const [form, setForm] = useState(() => Object.fromEntries(fields.map(([key]) => [key, saved ? String(saved[key] / 100) : ''])));
  const disabled = saving || sale.status === 'cancelled';
  const summary = saved && balances(sale, saved);

  async function save(event) {
    event.preventDefault();
    await run(() => commit(current => {
      const currentSale = current.sales.find(item => item.id === sale.id);
      if (currentSale?.product !== 'Carta Contemplada' || currentSale.status === 'cancelled') {
        throw new Error('A venda precisa estar ativa para atualizar os pagamentos.');
      }
      const values = Object.fromEntries(fields.map(([key]) => [key, cents(form[key] || '0')]));
      validateSettlement(currentSale, values);
      return {
        ...current,
        contemplatedSettlements: { ...current.contemplatedSettlements, [sale.id]: values },
      };
    }, 'Sinal e quitação da carta contemplada'), 'Pagamentos da operação salvos.');
  }

  return <div>
    <h3>Sinal e quitação da cota</h3>
    <p className="fin-note">Informe o total acumulado de cada campo. Nos complementos, inclua apenas pagamentos além do sinal. Registre sua comissão efetivamente recebida no Financeiro.</p>
    <form onSubmit={save}>
      <fieldset disabled={disabled} className="fin-fieldset">
        <div className="fin-form">
          {fields.map(([key, label]) => <Amount key={key} label={label} value={form[key]} onChange={value => setForm(previous => ({ ...previous, [key]: value }))}/>)}
        </div>
        <button className="btn-primary" type="submit">Salvar sinal e quitação</button>
      </fieldset>
    </form>
    {summary && <div className="fin-calculation">
      <span>Falta receber do cliente<strong>{money(summary.customerDue)}</strong></span>
      <span>Falta repassar ao parceiro<strong>{money(summary.partnerDue)}</strong></span>
      <span>Saldo da operação em mãos<strong>{money(summary.held)}</strong></span>
    </div>}
  </div>;
}

export function SettlementReport({ sales, state }) {
  const rows = sales.map(sale => {
    const entry = state.contemplatedSettlements?.[sale.id];
    const paid = netPaid(state, sale.id);
    return {
      sale, entry, paid,
      due: sale.own == null ? null : sale.own - paid,
      ...(entry ? balances(sale, entry) : {}),
    };
  });
  const columns = [
    ['Sinal recebido', row => row.entry?.customerDeposit],
    ['Sinal repassado', row => row.entry?.partnerDeposit],
    ['Total recebido do cliente', row => row.received],
    ['Falta receber do cliente', row => row.customerDue],
    ['Total repassado ao parceiro', row => row.transferred],
    ['Falta repassar ao parceiro', row => row.partnerDue],
    ['Saldo em mãos', row => row.held],
    ['Sua comissão recebida', row => row.paid],
    ['Sua comissão a receber', row => row.due],
  ];

  return <Panel title="Sinal e quitação · Contempladas" note="Pagamentos da cota e comissão recebida são controles separados. Os totais de pagamentos incluem as vendas com lançamento. Comissão recebida considera os registros do Financeiro, líquidos de devoluções.">
    <Table headers={['Cliente / fechamento', ...columns.map(([label]) => label)]}
      foot={rows.length > 0 && <tr><th scope="row">Total apurado</th>{columns.map(([label, value]) => {
        const amounts = rows.map(value).filter(amount => amount != null);
        return <td key={label}>{amounts.length ? money(amounts.reduce((total, amount) => total + amount, 0)) : '—'}</td>;
      })}</tr>}>
      {rows.map(row => <tr key={row.sale.id}>
        <th scope="row">{row.sale.name}<small>{dateLabel(row.sale.soldAt)}</small>
          {row.sale.supplier && <small>Parceiro: {row.sale.supplier}</small>}
          {!row.entry && <small>Pagamentos da cota não lançados</small>}
        </th>
        {columns.map(([label, value]) => <td key={label}>{value(row) == null ? '—' : money(value(row))}</td>)}
      </tr>)}
    </Table>
    {!rows.length && <Empty/>}
  </Panel>;
}
