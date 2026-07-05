import { useMemo, useState } from 'react';
import { PRODUTOS, STAGES } from '../constants.js';
import { exportLeadsCSV } from '../utils.js';

export default function ExportModal({ leads, onClose }) {
  const [produto, setProduto] = useState('Todos');
  const [etapa, setEtapa] = useState('Todos');

  const count = useMemo(() => {
    let filtered = leads;
    if (produto !== 'Todos') filtered = filtered.filter((l) => l.produto === produto);
    if (etapa !== 'Todos') filtered = filtered.filter((l) => l.etapa === etapa);
    return filtered.length;
  }, [leads, produto, etapa]);

  function handleConfirm() {
    const ok = exportLeadsCSV(leads, produto, etapa);
    if (ok) onClose();
  }

  return (
    <div className="overlay show">
      <div className="modal">
        <h2>Exportar leads para planilha</h2>
        <div className="field">
          <label htmlFor="exp-produto">Produto</label>
          <select id="exp-produto" value={produto} onChange={(e) => setProduto(e.target.value)}>
            {['Todos', ...PRODUTOS].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="exp-etapa">Etapa do funil</label>
          <select id="exp-etapa" value={etapa} onChange={(e) => setEtapa(e.target.value)}>
            {['Todos', ...STAGES].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
          {count} lead(s) encontrados com esse filtro.
        </div>
        <div className="modal-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
          <button type="button" className="btn-primary" onClick={handleConfirm}>Exportar CSV</button>
        </div>
      </div>
    </div>
  );
}
