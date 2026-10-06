import { useEffect, useState } from 'react';
import { interactionsApi } from '../lib/db.js';
import {
  INTERACTION_TYPE_LABEL, INTERACTION_CHANNEL_LABEL,
  COMMERCIAL_INTERACTION_ACTIONS, COMMERCIAL_INTERACTION_GROUPS,
} from '../constants.js';

function fmtDateTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// Fase 2A.2 — rotulagem de exibição para as interações comerciais
// estruturadas (call/whatsapp/meeting/proposal). Retorna null para
// qualquer outro tipo (note/stage_change/system/desconhecido), que cai
// no rótulo genérico já existente — zero mudança de exibição para eles.
function describeInteraction(it) {
  const outcome = it.metadata && it.metadata.outcome;
  if (it.type === 'call') {
    return {
      title: '📞 Ligação',
      secondary: outcome === 'connected' ? 'Atendeu' : outcome === 'no_answer' ? 'Não atendeu' : null,
    };
  }
  if (it.type === 'whatsapp') {
    return { title: it.direction === 'inbound' ? '💬 Cliente respondeu pelo WhatsApp' : '💬 WhatsApp enviado', secondary: null };
  }
  if (it.type === 'meeting') {
    return { title: '🤝 Reunião realizada', secondary: null };
  }
  if (it.type === 'proposal') {
    return { title: '📄 Proposta enviada', secondary: null };
  }
  return null;
}

export default function LeadTimeline({ leadId, onAddNote, onRegisterInteraction }) {
  const [interactions, setInteractions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [saving, setSaving] = useState(false);
  const [activeGroup, setActiveGroup] = useState(null);
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState('');
  const [successFlash, setSuccessFlash] = useState('');

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

  async function handleRegister(actionValue, actionLabel) {
    if (registering) return;
    setRegistering(true);
    setRegisterError('');
    try {
      const inserted = await onRegisterInteraction(leadId, actionValue);
      setInteractions((prev) => [inserted, ...prev]);
      setActiveGroup(null);
      setSuccessFlash(actionLabel);
      setTimeout(() => setSuccessFlash(''), 2500);
    } catch (e) {
      // Fica no mesmo submenu (não fecha, não limpa) para o vendedor poder
      // tentar de novo — nunca finge sucesso se o insert falhar.
      setRegisterError('Não foi possível registrar: ' + e.message);
    } finally {
      setRegistering(false);
    }
  }

  return (
    <div className="field">
      <label>Histórico</label>
      {onRegisterInteraction && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 4 }}>Registrar interação</div>
          <div className="filters" style={{ marginBottom: 0 }}>
            {activeGroup === null && COMMERCIAL_INTERACTION_GROUPS.map((g) => (
              <button type="button" key={g.value} className="chip" disabled={registering} onClick={() => setActiveGroup(g.value)}>
                {g.label}
              </button>
            ))}
            {activeGroup !== null && (
              <>
                {COMMERCIAL_INTERACTION_ACTIONS.filter((a) => a.group === activeGroup).map((a) => (
                  <button type="button" key={a.value} className="chip" disabled={registering} onClick={() => handleRegister(a.value, a.label)}>
                    {a.label}
                  </button>
                ))}
                <button type="button" className="chip" disabled={registering} onClick={() => { setActiveGroup(null); setRegisterError(''); }}>
                  ← Voltar
                </button>
              </>
            )}
          </div>
          {registerError && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 4 }}>{registerError}</div>}
          {successFlash && <div style={{ fontSize: 12, color: 'var(--green)', marginTop: 4 }}>✓ Registrado: {successFlash}</div>}
        </div>
      )}
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
          {interactions.map((it) => {
            const commercial = describeInteraction(it);
            return (
              <div key={it.id} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-dim)' }}>
                  <span>
                    {commercial
                      ? commercial.title
                      : (INTERACTION_TYPE_LABEL[it.type] || it.type) + (it.channel ? ' · ' + (INTERACTION_CHANNEL_LABEL[it.channel] || it.channel) : '')}
                  </span>
                  <span>{fmtDateTime(it.occurredAt)}</span>
                </div>
                {commercial && commercial.secondary && <div style={{ fontSize: 13, marginTop: 3 }}>{commercial.secondary}</div>}
                {!commercial && it.content && <div style={{ fontSize: 13, marginTop: 3 }}>{it.content}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
