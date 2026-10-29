import { PROD_COLOR, TAG_COLOR } from '../constants.js';
import { classifyLeadPriority, diasDesde, fmtBRL, fmtDate, leadHasNoNextAction, leadValor, todayStr } from '../utils.js';

function FinancialDetail({ label, children, wide }) {
  return <div className={wide ? 'financial-detail wide' : 'financial-detail'}><span>{label}</span><strong>{children}</strong></div>;
}

export function DetailLine({ lead }) {
  if (lead.produto === 'Carta Contemplada') {
    const pctEntrada = lead.credito > 0 && lead.entrada != null ? Math.round((Number(lead.entrada) / Number(lead.credito)) * 100) : null;
    return <div className="card-financials"><FinancialDetail label="Entrada">{fmtBRL(lead.entrada)}</FinancialDetail><FinancialDetail label="Parcela">{fmtBRL(lead.parcela)}</FinancialDetail>{pctEntrada !== null && <FinancialDetail label="Entrada / crédito" wide>{pctEntrada}% do crédito</FinancialDetail>}</div>;
  }
  if (lead.produto === 'Consórcio') {
    return <div className="card-financials"><FinancialDetail label="Parcela">{fmtBRL(lead.parcela)}</FinancialDetail><FinancialDetail label="Lance">{fmtBRL(lead.lance)}</FinancialDetail></div>;
  }
  if (lead.produto === 'Home Equity') {
    const ltv = lead.valorImovel > 0 && lead.valor != null ? Math.round((Number(lead.valor) / Number(lead.valorImovel)) * 100) : null;
    return <div className="card-financials"><FinancialDetail label="Imóvel avaliado em" wide>{fmtBRL(lead.valorImovel)}</FinancialDetail>{ltv !== null && <FinancialDetail label="LTV" wide>{ltv}%</FinancialDetail>}</div>;
  }
  if (lead.produto === 'Financiamento') {
    return <div className="card-financials"><FinancialDetail label="Entrada">{fmtBRL(lead.entrada)}</FinancialDetail><FinancialDetail label="Parcela">{fmtBRL(lead.parcela)}</FinancialDetail></div>;
  }
  return null;
}

// Etapa A — ÚNICA fonte de verdade é classifyLeadPriority/STALE_DAYS
// (utils.js). Antes desta correção, o limiar "15 dias" estava
// duplicado aqui como literal — agora delega inteiramente, nunca
// reimplementa o cálculo. Comportamento idêntico ao anterior (mesma
// condição: lead ativo, com diasDesde >= STALE_DAYS).
export function isLeadStale(lead) {
  return classifyLeadPriority(lead).includes('PARADO');
}

export function LeadCardBody({ lead, footer }) {
  const today = todayStr();
  const isFinal = lead.etapa === 'Ganho' || lead.etapa === 'Perdido';
  const dias = diasDesde(lead.ultimaAtualizacao || lead.criadoEm);
  const isStale = isLeadStale(lead);
  const late = lead.proximoContato && lead.proximoContato < today && !isFinal;

  return (
    <>
      <div className="card-top">
        <div>
          <div className="card-nome">{lead.nome}</div>
          <div className="card-fone">{lead.telefone || 'sem telefone'}</div>
        </div>
        <div className="card-product">
          <span className="prod-badge" style={{ '--product-color': lead.produto === 'A identificar' ? 'var(--text-dim)' : PROD_COLOR[lead.produto] || 'var(--text-dim)' }}>{lead.produto}</span>
          {(lead.tipo || ['Consórcio','Carta Contemplada','Financiamento'].includes(lead.produto)) && <span className="card-type">{lead.tipo || 'Finalidade a informar'}</span>}
        </div>
      </div>
      {(lead.tags && lead.tags.length > 0) || leadHasNoNextAction(lead) ? (
        <div className="card-tags">
          {lead.tags && lead.tags.map((tag) => (
            <span key={tag} className="badge lead-tag" style={{ '--tag-color': TAG_COLOR[tag] || 'var(--text-dim)' }}>
              {tag}
            </span>
          ))}
          {leadHasNoNextAction(lead) && (
            <span className="badge lead-tag" style={{ '--tag-color': 'var(--red)' }}>SEM PRÓXIMA AÇÃO</span>
          )}
        </div>
      ) : null}
      <div className="card-value-label">{['Consórcio', 'Carta Contemplada'].includes(lead.produto) ? 'Crédito' : 'Valor do negócio'}</div><div className="card-valor">{fmtBRL(leadValor(lead))}</div>
      <DetailLine lead={lead} />
      <div className="card-context">{lead.canal && <div><span>Origem</span>{lead.canal}</div>}{lead.cidade && <div><span>Cidade</span>{lead.cidade}</div>}</div>
      {lead.proximoContato && <div className={`card-next-contact ${late ? 'late' : ''}`}><strong>{late ? 'Próximo contato vencido' : 'Próximo contato'}</strong><span>{fmtDate(lead.proximoContato)}{lead.proximoContatoHorario ? ' · ' + lead.proximoContatoHorario : ''}</span></div>}
      <div className="card-meta card-idle">
        {!isFinal && dias !== null ? (
          isStale ? <span className="badge tag-overdue">Sem atualização de cadastro há {dias}d</span> : `Sem atualização de cadastro há ${dias}d`
        ) : ''}
      </div>
      {footer}
    </>
  );
}
