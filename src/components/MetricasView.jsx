import { useEffect, useMemo, useState } from 'react';
import { STAGES } from '../constants.js';
import { leadsApi, profilesApi } from '../lib/db.js';
import { fmtBRL, leadValor } from '../utils.js';
import { LeadCardBody, isLeadStale } from './LeadCardInfo.jsx';

export default function MetricasView({ userId }) {
  const [leads, setLeads] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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

      <div className="kanban">
        {STAGES.map((stage) => {
          const stageLeads = leads.filter((l) => l.etapa === stage);
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
                <div className="card" key={l.id} style={isLeadStale(l) ? { borderColor: 'var(--red)' } : undefined}>
                  <LeadCardBody
                    lead={l}
                    footer={<div className="card-meta">Vendedor(a): {emailByUserId[l.userId] || 'Sem e-mail'}</div>}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
