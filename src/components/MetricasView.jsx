import { useEffect, useMemo, useState } from 'react';
import { STAGES } from '../constants.js';
import { leadsApi, profilesApi } from '../lib/db.js';
import { fmtBRL, leadValor } from '../utils.js';

// O período filtra a data de cadastro, não a data de fechamento.
// Sem histórico completo de mudanças, os indicadores são uma fotografia
// do estágio ATUAL dos leads captados no intervalo escolhido.
export function buildCommercialDashboard(leads, { period = 'all', product = 'Todos', owner = 'Todos', now = new Date() } = {}) {
  const cutoff = period === 'all' ? null : new Date(now.getTime() - Number(period) * 86400000);
  const scoped = leads.filter((lead) => {
    if (lead.deletedAt) return false;
    if (product !== 'Todos' && lead.produto !== product) return false;
    if (owner !== 'Todos' && (lead.userId || '') !== owner) return false;
    if (!cutoff) return true;
    const created = lead.createdAt || lead.criadoEm;
    if (!created) return false;
    const date = new Date(created);
    return !Number.isNaN(date.getTime()) && date >= cutoff && date <= now;
  });
  const open = scoped.filter((lead) => !['Ganho', 'Perdido'].includes(lead.etapa));
  const won = scoped.filter((lead) => lead.etapa === 'Ganho');
  const lost = scoped.filter((lead) => lead.etapa === 'Perdido');
  const pipeline = open.reduce((sum, lead) => sum + leadValor(lead), 0);
  const byStage = STAGES.map((stage) => ({
    name: stage,
    count: scoped.filter((lead) => lead.etapa === stage).length,
  }));
  const group = (key) => Object.entries(scoped.reduce((acc, lead) => {
    const name = key === 'userId' ? (lead.userId || 'Sem responsável') : (lead[key] || 'Não informado');
    if (!acc[name]) acc[name] = { name, count: 0, won: 0, lost: 0, pipeline: 0 };
    acc[name].count += 1;
    if (lead.etapa === 'Ganho') acc[name].won += 1;
    if (lead.etapa === 'Perdido') acc[name].lost += 1;
    if (!['Ganho', 'Perdido'].includes(lead.etapa)) acc[name].pipeline += leadValor(lead);
    return acc;
  }, {})).map(([, value]) => value).sort((a, b) => b.count - a.count);
  return {
    total: scoped.length, open: open.length, won: won.length, lost: lost.length,
    pipeline, currentWonRate: scoped.length ? won.length / scoped.length : 0,
    byStage, byOwner: group('userId'), byProduct: group('produto'), byChannel: group('canal'),
  };
}

const cardStyle = { minWidth: 0 };
const tableStyle = { width: '100%', borderCollapse: 'collapse' };
const cellStyle = { padding: '10px 8px', borderBottom: '1px solid var(--border)', textAlign: 'left' };

function Breakdown({ title, rows, withPipeline = false }) {
  return (
    <div style={{ overflowX: 'auto', marginTop: 24 }}>
      <h3>{title}</h3>
      {rows.length === 0 ? <p className="empty-state">Sem dados para os filtros selecionados.</p> : (
        <table style={tableStyle}>
          <thead><tr><th style={cellStyle}>Categoria</th><th style={cellStyle}>Leads</th><th style={cellStyle}>Ganhos</th><th style={cellStyle}>Perdidos</th>{withPipeline && <th style={cellStyle}>Pipeline ativo</th>}</tr></thead>
          <tbody>{rows.map((row) => <tr key={row.name}>
            <td style={cellStyle}>{row.label || row.name}</td>
            <td style={cellStyle}>{row.count}</td>
            <td style={cellStyle}>{row.won}</td>
            <td style={cellStyle}>{row.lost}</td>
            {withPipeline && <td style={cellStyle}>{fmtBRL(row.pipeline)}</td>}
          </tr>)}</tbody>
        </table>
      )}
    </div>
  );
}

export default function MetricasView({ userId }) {
  const [leads, setLeads] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [period, setPeriod] = useState('all');
  const [product, setProduct] = useState('Todos');
  const [owner, setOwner] = useState('Todos');
  const [asOf, setAsOf] = useState(() => new Date());

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [allLeads, allProfiles] = await Promise.all([
        leadsApi.fetchAllForAdmin(), profilesApi.fetchAll(),
      ]);
      setLeads(allLeads);
      setProfiles(allProfiles);
      setAsOf(new Date());
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    Promise.all([leadsApi.fetchAllForAdmin(), profilesApi.fetchAll()])
      .then(([allLeads, allProfiles]) => {
        if (!active) return;
        setLeads(allLeads);
        setProfiles(allProfiles);
        setAsOf(new Date());
      })
      .catch((err) => { if (active) setError(err); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId]);

  const emailById = useMemo(() => Object.fromEntries(profiles.map((p) => [p.id, p.email || 'Sem e-mail'])), [profiles]);
  const products = useMemo(() => [...new Set(leads.map((l) => l.produto).filter(Boolean))].sort(), [leads]);
  const owners = useMemo(() => [...new Set(leads.map((l) => l.userId).filter(Boolean))], [leads]);
  const data = useMemo(() => buildCommercialDashboard(leads, { period, product, owner, now: asOf }), [leads, period, product, owner, asOf]);

  return (
    <section className="view active">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div><h2>Dashboard Comercial</h2><p style={{ opacity: .75 }}>Visão gerencial de toda a equipe, incluindo seus próprios leads.</p></div>
        <button type="button" onClick={refresh} disabled={loading}>Atualizar dados</button>
      </div>
      <div className="filters" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '18px 0' }}>
        <label>Cadastros <select aria-label="Período de cadastro" value={period} onChange={(e) => setPeriod(e.target.value)}>
          <option value="all">Todo o histórico</option><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option><option value="90">Últimos 90 dias</option>
        </select></label>
        <label>Produto <select aria-label="Produto" value={product} onChange={(e) => setProduct(e.target.value)}>
          <option>Todos</option>{products.map((p) => <option key={p}>{p}</option>)}
        </select></label>
        <label>Responsável <select aria-label="Responsável" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="Todos">Todos</option>{owners.map((id) => <option key={id} value={id}>{emailById[id] || 'Usuário sem perfil'}</option>)}
        </select></label>
      </div>
      {loading && <div className="empty-state">Carregando indicadores...</div>}
      {error && <div role="alert" className="empty-state" style={{ color: 'var(--red)' }}>Falha ao carregar dados: {error.message}</div>}
      {!loading && !error && <>
        <p style={{ fontSize: 13, opacity: .75 }}>Fotografia das etapas atuais dos leads cadastrados no período selecionado. Não representa fechamentos ocorridos no período nem faturamento recebido.</p>
        <div className="stats">
          {[
            ['Leads cadastrados', data.total],
            ['Oportunidades abertas', data.open],
            ['Negócios ganhos (etapa atual)', data.won],
            ['Negócios perdidos (etapa atual)', data.lost],
            ['Crédito/valor em pipeline ativo', fmtBRL(data.pipeline)],
            ['% dos cadastrados hoje em Ganho', (data.currentWonRate * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%'],
          ].map(([label, value]) => <div className="stat-card" style={cardStyle} key={label}><div className="num">{value}</div><div className="label">{label}</div></div>)}
        </div>
        <div style={{ marginTop: 24 }}>
          <h3>Distribuição atual do funil</h3>
          {data.byStage.map((stage) => (
            <div key={stage.name} style={{ display: 'grid', gridTemplateColumns: 'minmax(105px, 160px) 1fr 36px', gap: 12, alignItems: 'center', margin: '10px 0' }}>
              <span style={{ fontSize: 13 }}>{stage.name}</span>
              <div style={{ background: 'var(--border)', borderRadius: 5, height: 13, overflow: 'hidden' }}>
                <div style={{ width: (data.total ? stage.count / data.total * 100 : 0) + '%', background: 'var(--gold)', height: '100%' }} />
              </div>
              <strong>{stage.count}</strong>
            </div>
          ))}
        </div>
        <Breakdown title="Desempenho por responsável" rows={data.byOwner.map((row) => ({ ...row, label: emailById[row.name] || (row.name === 'Sem responsável' ? row.name : 'Usuário sem perfil') }))} withPipeline />
        <Breakdown title="Desempenho por produto" rows={data.byProduct} withPipeline />
        <Breakdown title="Origem dos leads" rows={data.byChannel} />
        <p style={{ marginTop: 20, fontSize: 12, opacity: .75 }}>O valor do pipeline é o valor de crédito ou do negócio informado no cadastro; não representa receita, comissão ou previsão garantida. Conversão histórica entre etapas e motivos de perda serão incluídos quando os registros permitirem apuração confiável.</p>
      </>}
    </section>
  );
}
