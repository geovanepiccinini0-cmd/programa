import { STAGES, PROD_COLOR } from '../constants.js';
import { diasDesde, fmtBRL, fmtDate, leadValor, todayStr } from '../utils.js';

function DetailLine({ lead }) {
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

function LeadCard({ lead, onEdit, onDelete, onMoveStage }) {
  const today = todayStr();
  const stage = lead.etapa;
  const idx = STAGES.indexOf(stage);
  const isFinal = stage === 'Ganho' || stage === 'Perdido';
  const dias = diasDesde(lead.ultimaAtualizacao || lead.criadoEm);
  const isStale = !isFinal && dias !== null && dias >= 15;
  const late = lead.proximoContato && lead.proximoContato < today && !isFinal;

  return (
    <div className="card" style={isStale ? { borderColor: 'var(--red)' } : undefined}>
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
        {lead.canal || ''}{lead.proximoContato ? ' · próx. contato ' + fmtDate(lead.proximoContato) : ''}
      </div>
      <div className="card-meta">
        {!isFinal && dias !== null ? (
          isStale ? <span className="badge tag-overdue">SEM CONTATO HÁ {dias}d</span> : `sem contato há ${dias}d`
        ) : ''}
      </div>
      <div className="card-actions">
        <button className="icon-btn" onClick={() => onMoveStage(lead.id, -1)} disabled={idx === 0}>◀</button>
        <button className="icon-btn" onClick={() => onEdit(lead)}>Editar</button>
        <button className="icon-btn" onClick={() => onMoveStage(lead.id, 1)} disabled={idx === STAGES.length - 1}>▶</button>
      </div>
      <div className="card-actions" style={{ marginTop: 4 }}>
        <button className="icon-btn del" style={{ flex: 1 }} onClick={() => onDelete(lead.id)}>Excluir lead</button>
      </div>
    </div>
  );
}

export default function Kanban({ leads, filterProduto, filterStale, onEdit, onDelete, onMoveStage }) {
  return (
    <div className="kanban">
      {STAGES.map((stage) => {
        let stageLeads = leads.filter((l) => l.etapa === stage);
        if (filterProduto !== 'Todos') stageLeads = stageLeads.filter((l) => l.produto === filterProduto);
        if (filterStale) stageLeads = stageLeads.filter((l) => diasDesde(l.ultimaAtualizacao || l.criadoEm) >= 15);
        stageLeads = stageLeads.slice().sort((a, b) => diasDesde(b.ultimaAtualizacao || b.criadoEm) - diasDesde(a.ultimaAtualizacao || a.criadoEm));
        const soma = stageLeads.reduce((s, l) => s + leadValor(l), 0);
        return (
          <div className="col" key={stage}>
            <div className="col-head">
              <h3>{stage}</h3>
              <span className="count">{stageLeads.length}</span>
            </div>
            {soma > 0 && <div className="col-sum">{fmtBRL(soma)}</div>}
            {stageLeads.length === 0 && <div className="empty-state" style={{ padding: '16px 6px' }}>—</div>}
            {stageLeads.map((l) => (
              <LeadCard key={l.id} lead={l} onEdit={onEdit} onDelete={onDelete} onMoveStage={onMoveStage} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
