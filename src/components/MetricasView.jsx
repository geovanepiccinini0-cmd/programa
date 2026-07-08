import { useEffect, useMemo, useState } from 'react';
import { STAGES } from '../constants.js';
import { leadsApi, profilesApi } from '../lib/db.js';
import { fmtBRL, leadValor, todayStr } from '../utils.js';
import Kanban from './Kanban.jsx';
import LeadModal from './LeadModal.jsx';

export default function MetricasView({ userId }) {
  const [leads, setLeads] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingLead, setEditingLead] = useState(null);
  const [leadModalOpen, setLeadModalOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [leadsData, profilesData] = await Promise.all([leadsApi.fetchAllForAdmin(), profilesApi.fetchAll()]);
        if (cancelled) return;
        setLeads(leadsData.filter((l) => l.userId !== userId));
        setProfiles(profilesData);
        setLoading(false);
      } catch (e) {
        if (!cancelled) { setError(e); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const emailByUserId = useMemo(() => {
    const map = {};
    profiles.forEach((p) => { map[p.id] = p.email || 'Sem e-mail'; });
    return map;
  }, [profiles]);

  const ativos = useMemo(() => leads.filter((l) => l.etapa !== 'Ganho' && l.etapa !== 'Perdido'), [leads]);
  const totalPipeline = useMemo(() => ativos.reduce((s, l) => s + leadValor(l), 0), [ativos]);

  const perUser = useMemo(() => {
    const map = {};
    ativos.forEach((l) => {
      const key = l.userId || 'desconhecido';
      if (!map[key]) map[key] = { count: 0, valor: 0 };
      map[key].count += 1;
      map[key].valor += leadValor(l);
    });
    return Object.entries(map)
      .map(([userId, stats]) => ({ userId, email: emailByUserId[userId] || 'Sem e-mail', ...stats }))
      .sort((a, b) => b.valor - a.valor);
  }, [ativos, emailByUserId]);

  function handleEditLead(lead) {
    setEditingLead(lead);
    setLeadModalOpen(true);
  }

  async function handleSaveLead(id, data) {
    const updated = await leadsApi.update(id, { ...data, ultimaAtualizacao: todayStr() });
    setLeads((prev) => prev.map((l) => (l.id === id ? updated : l)));
    setLeadModalOpen(false);
  }

  async function handleMoveStage(id, dir) {
    const lead = leads.find((l) => l.id === id);
    if (!lead) return;
    const idx = STAGES.indexOf(lead.etapa);
    const next = idx + dir;
    if (next < 0 || next >= STAGES.length) return;
    const updated = await leadsApi.update(id, { ...lead, etapa: STAGES[next], ultimaAtualizacao: todayStr() });
    setLeads((prev) => prev.map((l) => (l.id === id ? updated : l)));
  }

  if (loading) return <section className="view active"><div className="empty-state">Carregando métricas...</div></section>;
  if (error) {
    return (
      <section className="view active">
        <div className="empty-state" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
          Não foi possível carregar as métricas: {error.message}
        </div>
      </section>
    );
  }

  return (
    <section className="view active">
      <div className="stats">
        <div className="stat-card">
          <div className="num">{fmtBRL(totalPipeline)}</div>
          <div className="label">Pipeline ativo de toda a equipe ({ativos.length} leads)</div>
        </div>
        {perUser.map((u) => (
          <div className="stat-card" key={u.userId}>
            <div className="num">{fmtBRL(u.valor)}</div>
            <div className="label">{u.email} · {u.count} lead(s)</div>
          </div>
        ))}
      </div>

      <Kanban
        leads={leads}
        filterProduto="Todos"
        filterStale={false}
        onEdit={handleEditLead}
        onMoveStage={handleMoveStage}
      />

      {leadModalOpen && (
        <LeadModal
          lead={editingLead}
          tasks={[]}
          onClose={() => setLeadModalOpen(false)}
          onSave={handleSaveLead}
        />
      )}
    </section>
  );
}
