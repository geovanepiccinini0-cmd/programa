import { useMemo } from 'react';
import { PRODUTOS, PROD_COLOR } from '../constants.js';
import { fmtBRL, leadValor } from '../utils.js';

export default function HealthBar({ leads }) {
  const { total, slices } = useMemo(() => {
    const ativos = leads.filter((l) => l.etapa !== 'Ganho' && l.etapa !== 'Perdido');
    const total = ativos.reduce((s, l) => s + leadValor(l), 0);
    const slices = PRODUTOS.map((p) => {
      const soma = ativos.filter((l) => l.produto === p).reduce((s, l) => s + leadValor(l), 0);
      return { produto: p, soma, pct: total > 0 ? (soma / total) * 100 : 0 };
    }).filter((s) => s.soma > 0);
    return { total, slices };
  }, [leads]);

  if (total === 0) {
    return (
      <div className="health">
        <div className="health-top"><span>Distribuição do pipeline por produto</span></div>
        <div className="empty-state" style={{ border: 'none', padding: '6px 0 0' }}>
          Cadastre leads com valor estimado para ver a distribuição.
        </div>
      </div>
    );
  }

  return (
    <div className="health">
      <div className="health-top">
        <span>Distribuição do pipeline por produto</span>
        <span>{fmtBRL(total)}</span>
      </div>
      <div className="health-bar">
        {slices.map((s) => (
          <div key={s.produto} style={{ width: `${s.pct.toFixed(1)}%`, background: PROD_COLOR[s.produto] }} />
        ))}
      </div>
      <div className="health-legend">
        {slices.map((s) => (
          <span key={s.produto}>
            <span className="dot" style={{ background: PROD_COLOR[s.produto] }} />
            {s.produto} · {fmtBRL(s.soma)}
          </span>
        ))}
      </div>
    </div>
  );
}
