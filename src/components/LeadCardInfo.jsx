import { PROD_COLOR } from '../constants.js';
import { diasDesde, fmtBRL, fmtDate, leadValor, todayStr } from '../utils.js';

export function DetailLine({ lead }) {
  if (lead.produto === 'Carta Contemplada') {
    const pctEntrada = lead.credito > 0 && lead.entrada != null ? Math.round((Number(lead.entrada) / Number(lead.credito)) * 100) : null;
    return <div className="card-meta">{lead.tipo ? lead.tipo + ' · ' : ''}Entrada {fmtBRL(lead.entrada)}{pctEntrada !== null ? ' (' + pctEntrada + '% do crédito)' : ''} · Parcela {fmtBRL(lead.parcela)}</div>;
  }
  if (lead.produto === 'Consórcio') {
    return <div className="card-meta">{lead.tipo ? lead.tipo + ' · ' : ''}Parcela {fmtBRL(lead.parcela)} · Lance {fmtBRL(lead.lance)}</div>;
  }
  if (lead.produto === 'Home Equity') {
    const ltv = lead.valorImovel > 0 && lead.valor != null ? Math.round((Number(lead.valor) / Number(lead.valorImovel)) * 100) : null;
    return <div className="card-meta">Imóvel avaliado em {fmtBRL(lead.valorImovel)}{ltv !== null ? ' · LTV ' + ltv + '%' : ''}</div>;
  }
  return null;
}

export function isLeadStale(lead) {
  const isFinal = lead.etapa === 'Ganho' || lead.etapa === 'Perdido';
  const dias = diasDesde(lead.ultimaAtualizacao || lead.criadoEm);
  return !isFinal && dias !== null && dias >= 15;
}

export function LeadCardBody({ lead, footer }) {
  const today = todayStr();
  const isFinal = lead.etapa === 'Ganho' || lead.etapa === 'Perdido';
  const dias = diasDesde(lead.ultimaAtualizacao || lead.criadoEm);
  const isStale = !isFinal && dias !== null && dias >= 15;
  const late = lead.proximoContato && lead.proximoContato < today && !isFinal;

  return (
    <>
      <div className="card-top">
        <div>
          <div className="card-nome">{lead.nome}</div>
          <div className="card-fone">{lead.telefone || 'sem telefone'}</div>
        </div>
        <span className="prod-badge" style={{ background: PROD_COLOR[lead.produto] || '#888' }}>{lead.produto}</span>
      </div>
      <div className="card-valor">{fmtBRL(leadValor(lead))}</div>
      <DetailLine lead={lead} />
      <div className={`card-meta ${late ? 'late' : ''}`}>
        {lead.canal || ''}{lead.proximoContato ? ' · próx. contato ' + fmtDate(lead.proximoContato) + (lead.proximoContatoHorario ? ' ' + lead.proximoContatoHorario : '') : ''}
      </div>
      <div className="card-meta">
        {!isFinal && dias !== null ? (
          isStale ? <span className="badge tag-overdue">SEM CONTATO HÁ {dias}d</span> : `sem contato há ${dias}d`
        ) : ''}
      </div>
      {footer}
    </>
  );
}
