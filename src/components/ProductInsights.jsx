import { useState } from 'react';
import { PROD_COLOR } from '../constants.js';
import { fmtBRL } from '../utils.js';

const percent = (value) => value.toLocaleString('pt-BR', { style: 'percent', maximumFractionDigits: 1 });
const point = (radius, degrees) => {
  const angle = (degrees - 90) * Math.PI / 180;
  return [140 + radius * Math.cos(angle), 140 + radius * Math.sin(angle)];
};

export function productRingPath(start, end) {
  const outer = 118, inner = 85;
  const a = point(outer, start), b = point(outer, end), c = point(inner, end), d = point(inner, start);
  if (end - start >= 359.9999) {
    const middleOuter = point(outer, start + 180), middleInner = point(inner, start + 180);
    return `M${a} A${outer},${outer} 0 1 1 ${middleOuter} A${outer},${outer} 0 1 1 ${a} L${d} A${inner},${inner} 0 1 0 ${middleInner} A${inner},${inner} 0 1 0 ${d} Z`;
  }
  const large = end - start > 180 ? 1 : 0;
  return `M${a} A${outer},${outer} 0 ${large} 1 ${b} L${c} A${inner},${inner} 0 ${large} 0 ${d} Z`;
}

export default function ProductInsights({ rows, total, onFilter, onReport }) {
  const [selectedName, setSelectedName] = useState(null);
  const [hoveredName, setHoveredName] = useState(null);
  const selected = rows.find((row) => row.name === selectedName);
  const emphasized = rows.find((row) => row.name === hoveredName) || selected;
  const select = (name) => setSelectedName((previous) => previous === name ? null : name);
  const color = (name) => name === 'A identificar' ? '#9aa9b8' : PROD_COLOR[name] || 'var(--text-dim)';
  let angle = 0;
  const segments = rows.filter((row) => row.count > 0).map((row) => {
    const start = angle;
    angle += total ? row.count / total * 360 : 0;
    return { ...row, path: productRingPath(start, angle), share: total ? row.count / total : 0 };
  });

  if (!total || !segments.length) return <p className="chart-empty">Nenhum lead para os filtros selecionados.</p>;

  return <div className="product-insights" onKeyDown={(event) => { if (event.key === 'Escape') { setSelectedName(null); setHoveredName(null); } }}>
    <div className="product-explorer">
      <div className="product-figure">
        <svg viewBox="0 0 280 280" className="product-ring" aria-label="Participação de leads por produto">
          <title>Interesse por produto — selecione uma fatia para explorar</title>
          {segments.map((row) => <path key={row.name} d={row.path} fill={color(row.name)} className={`product-segment ${emphasized && emphasized.name !== row.name ? 'dimmed' : ''} ${selected?.name === row.name ? 'selected' : ''}`} role="button" tabIndex={0} aria-pressed={selected?.name === row.name} aria-label={`${row.name}: ${row.count} leads, ${percent(row.share)}. Selecionar produto.`}
            onMouseEnter={() => setHoveredName(row.name)} onMouseLeave={() => setHoveredName(null)} onFocus={() => setHoveredName(row.name)} onBlur={() => setHoveredName(null)} onClick={() => select(row.name)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(row.name); } }}><title>{row.name}: {row.count} leads · {percent(row.share)}</title></path>)}
        </svg>
        <div className="product-ring-center"><span>{emphasized ? 'Participação' : 'Total da seleção'}</span><strong>{emphasized ? percent(emphasized.count / total) : total.toLocaleString('pt-BR')}</strong><span className="product-center-name">{emphasized ? emphasized.name : 'leads cadastrados'}</span>{emphasized && <span>{emphasized.count} de {total} leads</span>}</div>
      </div>
      <div className="product-options" aria-label="Selecionar produto">
        {segments.map((row) => <button type="button" key={row.name} className="product-option" aria-pressed={selected?.name === row.name} onMouseEnter={() => setHoveredName(row.name)} onMouseLeave={() => setHoveredName(null)} onFocus={() => setHoveredName(row.name)} onBlur={() => setHoveredName(null)} onClick={() => select(row.name)}>
          <span className="product-option-top"><i style={{ background: color(row.name) }} aria-hidden="true"/><span className="product-option-name">{row.name}</span><strong>{row.count}</strong><span className="product-option-share">{percent(row.share)}</span></span><span className="product-share-track" aria-hidden="true"><span style={{ width: `${row.share * 100}%`, background: color(row.name) }}/></span>
        </button>)}
      </div>
    </div>
    {selected ? <div className="product-selection">
      <div className="product-selection-heading"><div><span className="eyebrow">Produto selecionado</span><h3>{selected.name}</h3><p>{selected.count} leads · {percent(selected.count / total)} da seleção atual</p></div><button type="button" className="product-clear" onClick={() => { setSelectedName(null); setHoveredName(null); }}>Limpar destaque</button></div>
      <div className="product-detail-grid" role="status"><div><strong>{selected.count - selected.won - selected.lost}</strong><span>Em aberto</span></div><div><strong>{selected.won}</strong><span>Em Ganho</span></div><div><strong>{selected.lost}</strong><span>Em Perdido</span></div></div>
      <div className="product-pipeline"><span>Pipeline ativo</span><strong>{fmtBRL(selected.pipeline)}</strong></div>
      <div className="product-detail-actions"><button type="button" className="btn-ghost" onClick={() => onFilter(selected.name)}>Filtrar dashboard</button><button type="button" className="btn-primary" onClick={() => onReport(selected.name)}>Ver relatório do produto</button></div>
    </div> : <p className="product-interaction-hint">Selecione uma fatia ou um produto para ver oportunidades e valores.</p>}
  </div>;
}
