import { useState } from 'react';
import { STAGES } from '../constants.js';
import { diasDesde, fmtBRL, leadValor } from '../utils.js';
import { LeadCardBody, isLeadStale } from './LeadCardInfo.jsx';

function LeadCard({ lead, onEdit, onDelete, onMoveStage, onDragStart }) {
  const idx = STAGES.indexOf(lead.etapa);
  const isStale = isLeadStale(lead);

  return (
    <div
      className="card"
      draggable
      onDragStart={(e) => onDragStart(e, lead.id)}
      style={isStale ? { borderColor: 'var(--red)' } : undefined}
    >
      <LeadCardBody
        lead={lead}
        footer={(
          <>
            <div className="card-actions">
              <button className="icon-btn" onClick={() => onMoveStage(lead.id, -1)} disabled={idx === 0}>◀</button>
              <button className="icon-btn" onClick={() => onEdit(lead)}>Editar</button>
              <button className="icon-btn" onClick={() => onMoveStage(lead.id, 1)} disabled={idx === STAGES.length - 1}>▶</button>
            </div>
            {onDelete && (
              <div className="card-actions" style={{ marginTop: 4 }}>
                <button className="icon-btn del" style={{ flex: 1 }} onClick={() => onDelete(lead.id)}>Excluir lead</button>
              </div>
            )}
          </>
        )}
      />
    </div>
  );
}

function sortStageLeads(stageLeads, sortOrder) {
  const arr = stageLeads.slice();
  if (sortOrder === 'novo') {
    arr.sort((a, b) => (b.createdAt || b.criadoEm || '').localeCompare(a.createdAt || a.criadoEm || ''));
  } else if (sortOrder === 'antigo') {
    arr.sort((a, b) => (a.createdAt || a.criadoEm || '').localeCompare(b.createdAt || b.criadoEm || ''));
  } else {
    arr.sort((a, b) => diasDesde(b.ultimaAtualizacao || b.criadoEm) - diasDesde(a.ultimaAtualizacao || a.criadoEm));
  }
  return arr;
}

export default function Kanban({ leads, filterProduto, filterStale, sortOrder, onEdit, onDelete, onMoveStage, onDropStage }) {
  const [dragOverStage, setDragOverStage] = useState(null);

  function handleDragStart(e, leadId) {
    e.dataTransfer.setData('text/plain', leadId);
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragOver(e, stage) {
    if (!onDropStage) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverStage !== stage) setDragOverStage(stage);
  }

  function handleDrop(e, stage) {
    if (!onDropStage) return;
    e.preventDefault();
    setDragOverStage(null);
    const leadId = e.dataTransfer.getData('text/plain');
    if (leadId) onDropStage(leadId, stage);
  }

  return (
    <div className="kanban">
      {STAGES.map((stage) => {
        let stageLeads = leads.filter((l) => l.etapa === stage);
        if (filterProduto !== 'Todos') stageLeads = stageLeads.filter((l) => l.produto === filterProduto);
        if (filterStale) stageLeads = stageLeads.filter((l) => diasDesde(l.ultimaAtualizacao || l.criadoEm) >= 15);
        stageLeads = sortStageLeads(stageLeads, sortOrder);
        const soma = stageLeads.reduce((s, l) => s + leadValor(l), 0);
        return (
          <div
            className={`col ${dragOverStage === stage ? 'drag-over' : ''}`}
            key={stage}
            onDragOver={(e) => handleDragOver(e, stage)}
            onDragLeave={() => setDragOverStage((s) => (s === stage ? null : s))}
            onDrop={(e) => handleDrop(e, stage)}
          >
            <div className="col-head">
              <h3>{stage}</h3>
              <span className="count">{stageLeads.length}</span>
            </div>
            {soma > 0 && <div className="col-sum">{fmtBRL(soma)}</div>}
            {stageLeads.length === 0 && <div className="empty-state" style={{ padding: '16px 6px' }}>—</div>}
            {stageLeads.map((l) => (
              <LeadCard key={l.id} lead={l} onEdit={onEdit} onDelete={onDelete} onMoveStage={onMoveStage} onDragStart={handleDragStart} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
