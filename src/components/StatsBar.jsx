import { useMemo } from 'react';
import { STALE_DAYS } from '../constants.js';
import { diasDesde, fmtBRL, isTaskOverdue, leadValor, todayStr } from '../utils.js';

export default function StatsBar({ leads, tasks }) {
  const stats = useMemo(() => {
    const today = todayStr();
    const ativos = leads.filter((l) => l.etapa !== 'Ganho' && l.etapa !== 'Perdido');
    const pipelineValor = ativos.reduce((s, l) => s + leadValor(l), 0);
    const atrasados = tasks.filter((t) => t.categoria === 'Follow-up' && isTaskOverdue(t)).length;
    const hojeTotal = tasks.filter((t) => t.data === today).length;
    const hojeFeitas = tasks.filter((t) => t.data === today && t.concluida).length;
    const parados = ativos.filter((l) => diasDesde(l.ultimaAtualizacao || l.criadoEm) >= STALE_DAYS).length;
    return { ativos, pipelineValor, atrasados, hojeTotal, hojeFeitas, parados };
  }, [leads, tasks]);

  return (
    <div className="stats">
      <div className="stat-card">
        <div className="num">{fmtBRL(stats.pipelineValor)}</div>
        <div className="label">Pipeline ativo ({stats.ativos.length} leads)</div>
      </div>
      <div className={`stat-card ${stats.atrasados > 0 ? 'warn' : ''}`}>
        <div className="num">{stats.atrasados}</div>
        <div className="label">Follow-ups atrasados</div>
      </div>
      <div className={`stat-card ${stats.parados > 0 ? 'warn' : ''}`}>
        <div className="num">{stats.parados}</div>
        <div className="label">Parados há {STALE_DAYS}+ dias (retrabalho)</div>
      </div>
      <div className="stat-card ok">
        <div className="num">{stats.hojeFeitas}/{stats.hojeTotal}</div>
        <div className="label">Tarefas concluídas hoje</div>
      </div>
    </div>
  );
}
