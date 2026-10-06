import { useEffect, useState } from 'react';
import { interactionsApi } from '../lib/db.js';
import { INTERACTION_TYPE_LABEL, INTERACTION_CHANNEL_LABEL } from '../constants.js';

function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

export default function LeadTimeline({ leadId, onAddNote }) {
  const [interactions, setInteractions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    interactionsApi.fetchForLead(leadId)
      .then((data) => { if (!cancelled) { setInteractions(data); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [leadId]);

  async function handleAddNote() {
    const trimmed = noteText.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const inserted = await onAddNote(leadId, trimmed);
      setInteractions((prev) => [inserted, ...prev]);
      setNoteText('');
    } catch (e) {
      alert('Não foi possível salvar a nota: ' + e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="field">
      <label>Histórico</label>
      {onAddNote && (
        <div className="add-task-form" style={{ marginBottom: 10 }}>
          <input
            type="text"
            placeholder="Adicionar nota ao histórico..."
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddNote(); } }}
          />
          <button type="button" className="btn-primary" onClick={handleAddNote} disabled={saving}>Adicionar nota</button>
        </div>
      )}
      {loading && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Carregando histórico...</div>}
      {error && <div style={{ fontSize: 12, color: 'var(--red)' }}>Não foi possível carregar o histórico (a migration 007 já foi rodada no Supabase?).</div>}
      {!loading && !error && interactions.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>Nenhuma interação registrada ainda.</div>
      )}
      {!loading && interactions.length > 0 && (
        <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {interactions.map((it) => (
            <div key={it.id} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-dim)' }}>
                <span>{INTERACTION_TYPE_LABEL[it.type] || it.type}{it.channel ? ' · ' + (INTERACTION_CHANNEL_LABEL[it.channel] || it.channel) : ''}</span>
                <span>{fmtDateTime(it.occurredAt)}</span>
              </div>
              {it.content && <div style={{ fontSize: 13, marginTop: 3 }}>{it.content}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
