import { useEffect, useMemo, useRef, useState } from 'react';
import { leadsApi, profilesApi } from '../lib/db.js';
import { buildCommercialDashboard, dashboardCSV } from '../lib/commercialDashboard.js';
import { fmtBRL, todayStr } from '../utils.js';
import Icon from './Icon.jsx';
import ProductInsights from './ProductInsights.jsx';

export { buildCommercialDashboard } from '../lib/commercialDashboard.js';
const PERIODS = { all: 'Todo o histórico', 7: 'Últimos 7 dias', 30: 'Últimos 30 dias', 90: 'Últimos 90 dias' };
const GROUPS = { byProduct: 'Produto', byChannel: 'Origem', byOwner: 'Responsável', byLostReason: 'Motivo de perda' };
const percent = (value) => value.toLocaleString('pt-BR', { style: 'percent', maximumFractionDigits: 1 });

function Bars({ rows, stage = false }) {
  const maximum = Math.max(1, ...rows.map((row) => row.count));
  if (!rows.length) return <p className="chart-empty">Sem dados para os filtros selecionados.</p>;
  return <div className={stage ? 'chart-bars stage-bars' : 'chart-bars'}>{rows.map((row) => (
    <div className="chart-bar-row" key={row.name}><span>{row.label || row.name}</span><div className="chart-track" aria-hidden="true"><div className={`chart-fill ${row.name === 'Ganho' ? 'won' : row.name === 'Negociação' ? 'negotiation' : ''}`} style={{ width: `${row.count / maximum * 100}%` }} /></div><strong>{row.count}</strong></div>
  ))}</div>;
}

function AcquisitionChart({ acquisition }) {
  const container = useRef(null);
  const [width, setWidth] = useState(480);
  useEffect(() => {
    if (!container.current || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => { if (entry.contentRect.width > 0) setWidth(entry.contentRect.width); });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const { bins, undated } = acquisition;
  const height = 210, left = 32, right = 16, top = 22, bottom = 40;
  const maximum = Math.max(1, ...bins.map((bin) => bin.count));
  const x = (i) => bins.length === 1 ? width / 2 : left + i * (width - left - right) / (bins.length - 1);
  const y = (count) => height - bottom - count / maximum * (height - top - bottom);
  const path = bins.map((bin, i) => `${i ? 'L' : 'M'}${x(i)},${y(bin.count)}`).join(' ');
  const tickStep = Math.max(1, Math.ceil((bins.length - 1) / (width < 400 ? 2 : 3)));
  return <div ref={container} className="acquisition-chart">
    {!bins.length ? <p className="chart-empty">Nenhum cadastro com data válida nesta seleção.</p> : <>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Evolução da captação: quantidade de novos cadastros por intervalo">
        <title>Evolução da captação</title><desc>{bins.map((bin) => `${bin.range}: ${bin.count} leads`).join('; ')}</desc>
        {[0, maximum].map((count) => <g key={count}><line x1={left} x2={width - right} y1={y(count)} y2={y(count)} className="chart-grid-line"/><text x={left - 8} y={y(count) + 4} textAnchor="end">{count}</text></g>)}
        {bins.length > 1 && <path d={`${path} L${x(bins.length - 1)},${height - bottom} L${x(0)},${height - bottom} Z`} className="acquisition-area"/>}
        <path d={path} className="acquisition-line"/>
        {bins.map((bin, i) => <g key={bin.date}><circle cx={x(i)} cy={y(bin.count)} r="4" className="acquisition-point"><title>{bin.range}: {bin.count} leads</title></circle>{(i % tickStep === 0 || i === bins.length - 1) && <><text x={x(i)} y={height - 18} textAnchor={i === 0 ? 'start' : i === bins.length - 1 ? 'end' : 'middle'}>{bin.label}</text><text x={x(i)} y={y(bin.count) - 10} textAnchor={i === 0 ? 'start' : i === bins.length - 1 ? 'end' : 'middle'}>{bin.count}</text></>}</g>)}
        <text x="0" y="11">Leads</text><text x={width - right} y={height - 2} textAnchor="end">Data de cadastro</text>
      </svg>
      <details className="chart-data"><summary>Ver dados da captação</summary><table className="dashboard-table"><thead><tr><th>Intervalo</th><th>Leads</th></tr></thead><tbody>{bins.map((bin) => <tr key={bin.date}><td>{bin.range}</td><td>{bin.count}</td></tr>)}</tbody></table></details>
    </>}
    {undated > 0 && <p className="chart-note">{undated} cadastro(s) sem data válida para este gráfico. Permanecem nos totais quando o período é “Todo o histórico”.</p>}
  </div>;
}

function ReportTable({ rows, category, lostReasons }) {
  if (!rows.length) return <p className="chart-empty">Sem dados para os filtros selecionados.</p>;
  return <div className="dashboard-table-scroll"><table className="dashboard-table"><thead><tr><th scope="col">{category}</th><th scope="col">Leads</th>{!lostReasons && <><th scope="col">Ganhos</th><th scope="col">Perdidos</th><th scope="col">Pipeline ativo</th></>}</tr></thead><tbody>{rows.map((row) => <tr key={row.name}><th scope="row">{row.label || row.name}</th><td>{row.count}</td>{!lostReasons && <><td>{row.won}</td><td>{row.lost}</td><td>{fmtBRL(row.pipeline)}</td></>}</tr>)}</tbody></table></div>;
}

// Pure presentation: the authenticated admin loading path stays in MetricasView.
export function CommercialDashboard({ leads, profiles, asOf, loading = false, error = null, onRefresh }) {
  const [period, setPeriod] = useState('all');
  const [product, setProduct] = useState('Todos');
  const [owner, setOwner] = useState('Todos');
  const [view, setView] = useState('overview');
  const [group, setGroup] = useState('byProduct');
  const emailById = useMemo(() => Object.fromEntries(profiles.map((profile) => [profile.id, profile.email || 'Sem e-mail'])), [profiles]);
  const products = useMemo(() => [...new Set(leads.filter((lead) => !lead.deletedAt).map((lead) => lead.produto).filter(Boolean))].sort(), [leads]);
  const owners = useMemo(() => [...new Set(leads.filter((lead) => !lead.deletedAt).map((lead) => lead.userId).filter(Boolean))], [leads]);
  const data = useMemo(() => buildCommercialDashboard(leads, { period, product, owner, now: asOf }), [leads, period, product, owner, asOf]);
  const rows = group === 'byOwner' ? data.byOwner.map((row) => ({ ...row, label: emailById[row.name] || (row.name === 'Sem responsável' ? row.name : 'Usuário sem perfil') })) : data[group];
  const ownerLabel = owner === 'Todos' ? 'Toda a equipe' : emailById[owner] || 'Usuário sem perfil';
  function exportCSV() {
    const csv = dashboardCSV(rows, { category: GROUPS[group], period: PERIODS[period], product, owner: ownerLabel, asOf });
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a'); link.href = url; link.download = `relatorio-comercial-${group}-${todayStr()}.csv`;
    document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(url);
  }
  return <section className="view dashboard" aria-label="Métricas comerciais">
    <div className="dashboard-heading"><div className="page-heading"><span className="eyebrow">Painel Piccinini · Métricas</span><h1>Visão do seu negócio</h1><p>Oportunidades, origens e prioridades de toda a equipe, incluindo seus leads.</p></div><div className="dashboard-actions"><button className="btn-ghost" type="button" onClick={onRefresh} disabled={loading}>{loading ? 'Atualizando...' : 'Atualizar dados'}</button><button className="btn-primary" type="button" onClick={() => setView('report')}><Icon name="file"/>Ver relatório</button></div></div>
    <div className="dashboard-filters"><label>Data de cadastro<select value={period} onChange={(event) => setPeriod(event.target.value)} aria-label="Período de cadastro">{Object.entries(PERIODS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Produto<select value={product} onChange={(event) => setProduct(event.target.value)} aria-label="Produto"><option value="Todos">Todos os produtos</option>{products.map((name) => <option key={name}>{name}</option>)}</select></label><label>Responsável<select value={owner} onChange={(event) => setOwner(event.target.value)} aria-label="Responsável"><option value="Todos">Toda a equipe</option>{owners.map((id) => <option key={id} value={id}>{emailById[id] || 'Usuário sem perfil'}</option>)}</select></label></div>
    <div className="dashboard-tabs" aria-label="Visualização de métricas"><button type="button" aria-pressed={view === 'overview'} onClick={() => setView('overview')}>Visão geral</button><button type="button" aria-pressed={view === 'report'} onClick={() => setView('report')}>Relatórios</button></div>
    {loading && <p className="empty-state" role="status">Carregando indicadores...</p>}
    {error && <p className="empty-state" role="alert">Falha ao carregar dados: {error.message}. Use “Atualizar dados” para tentar novamente.</p>}
    {!loading && !error && <>
      <p className="dashboard-scope">Etapas atuais dos leads cadastrados no período selecionado. Não representa fechamentos ocorridos no período.</p>
      {view === 'overview' ? <>
        <div className="dashboard-kpis">{[['Leads cadastrados', data.total, 'No período selecionado'], ['Em aberto', data.open, 'Oportunidades ativas'], ['Pipeline ativo', fmtBRL(data.pipeline), 'Crédito / valor dos negócios'], ['Em negociação', data.negotiations, 'Etapa atual do lead']].map(([label, value, detail], index) => <div className={`stat-card ${index === 2 ? 'featured' : ''}`} key={label}><div className="label">{label}</div><div className="num">{value}</div><div className="stat-detail">{detail}</div></div>)}</div>
        <div className="dashboard-secondary"><span><i className="status-dot won"/><strong>{data.won}</strong> em Ganho</span><span><i className="status-dot lost"/><strong>{data.lost}</strong> em Perdido</span><span><strong>{percent(data.currentWonRate)}</strong> dos cadastros estão em Ganho</span></div>
        <div className="dashboard-grid">
          <section className="dashboard-panel"><h2>Evolução da captação</h2><p className="chart-note">Novos cadastros por intervalo · quantidade de leads</p><AcquisitionChart acquisition={data.acquisition}/></section>
          <section className="dashboard-panel"><h2>Onde estão as oportunidades</h2><p className="chart-note">Distribuição atual pelas 11 etapas · quantidade de leads</p><Bars rows={data.byStage} stage/></section>
          <section className="dashboard-panel"><h2>De onde vêm seus leads</h2><p className="chart-note">Volume por canal de origem</p><Bars rows={data.byChannel}/></section>
          <section className="dashboard-panel product-panel"><h2>Interesse por produto</h2><p className="chart-note">Participação no total de cadastros · selecione para explorar</p><ProductInsights key={`${period}|${product}|${owner}`} rows={data.byProduct} total={data.total} onFilter={setProduct} onReport={(name) => { setProduct(name); setGroup('byProduct'); setView('report'); }}/></section>
        </div>
        <section className="dashboard-priorities"><div><span className="eyebrow">Prioridades comerciais</span><h2>O que precisa da sua atenção</h2><p>Indicadores podem se sobrepor; não representam quantidade de tarefas.</p></div><div className="priority-grid"><div><strong>{data.overdueNextContact}</strong><span>Próximos contatos vencidos</span><small>Data de próximo contato anterior a hoje.</small></div><div><strong>{data.staleRegistrations}</strong><span>Cadastros sem atualização há 15+ dias</span><small>Última atualização do cadastro; não último contato.</small></div><div><strong>{data.negotiations}</strong><span>Oportunidades em negociação</span><small>Leads atualmente na etapa Negociação.</small></div></div></section>
      </> : <section className="dashboard-panel report-panel">
        <div className="report-heading"><div><h2>Relatório comercial</h2><p className="chart-note">{PERIODS[period]} · {product === 'Todos' ? 'Todos os produtos' : product} · {ownerLabel}</p></div><div className="dashboard-actions"><button className="btn-ghost" type="button" onClick={() => window.print()}>Imprimir / PDF</button><button className="btn-primary" type="button" onClick={exportCSV} disabled={!rows.length}>Exportar CSV</button></div></div>
        <div className="report-groups" aria-label="Agrupamento do relatório">{Object.entries(GROUPS).map(([key, label]) => <button className="chip" type="button" key={key} aria-pressed={group === key} onClick={() => setGroup(key)}>{label}</button>)}</div>
        {group === 'byLostReason' && <p className="chart-note">Somente leads atualmente em Perdido. Ausência de motivo registrado aparece como “Não informado”.</p>}
        <ReportTable rows={rows} category={GROUPS[group]} lostReasons={group === 'byLostReason'}/>
        <p className="report-summary">{data.total} leads na seleção · {data.won} em Ganho · {data.lost} em Perdido · {fmtBRL(data.pipeline)} em pipeline ativo.</p>
      </section>}
      <p className="dashboard-footnote">Atualizado em {asOf.toLocaleString('pt-BR')}. Pipeline é crédito/valor do negócio; não é receita, comissão ou previsão garantida. Conversão histórica entre etapas depende de histórico completo.</p>
    </>}
  </section>;
}

export default function MetricasView({ userId }) {
  const [leads, setLeads] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [asOf, setAsOf] = useState(() => new Date());
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let active = true; setLoading(true); setError(null);
    Promise.all([leadsApi.fetchAllForAdmin(), profilesApi.fetchAll()])
      .then(([allLeads, allProfiles]) => { if (active) { setLeads(allLeads); setProfiles(allProfiles); setAsOf(new Date()); } })
      .catch((err) => { if (active) setError(err); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [userId, refreshKey]);
  return <CommercialDashboard leads={leads} profiles={profiles} asOf={asOf} loading={loading} error={error} onRefresh={() => setRefreshKey((value) => value + 1)}/>;
}
