import { useMemo } from 'react';
import { PROD_COLOR } from '../constants.js';
import { currentWeekDates, fmtDate, isTaskOverdue, todayStr, weekdayLongName } from '../utils.js';

export default function WeekAgenda({ tasks, leads, onToggleTask, onDeleteTask }) {
  const weekDates = useMemo(() => currentWeekDates(), []);
  const today = todayStr();

  const byDay = useMemo(() => {
    const agendados = tasks.filter((t) => t.categoria === 'Agenda/Ligação');
    const map = {};
    weekDates.forEach((d) => { map[d] = []; });
    agendados.forEach((t) => {
      if (map[t.data]) map[t.data].push(t);
    });
    Object.keys(map).forEach((d) => {
      map[d].sort((a, b) => (a.horario || '99:99').localeCompare(b.horario || '99:99'));
    });
    return map;
  }, [tasks, weekDates]);

  return (
    <div>
      {weekDates.map((d) => {
        const items = byDay[d] || [];
        return (
          <div className="task-group" key={d}>
            <h3>{weekdayLongName(d)} · {fmtDate(d)}{d === today ? ' · hoje' : ''}</h3>
            {items.length === 0 ? (
              <div className="card-meta" style={{ padding: '2px 2px 8px' }}>Sem atendimentos agendados</div>
            ) : (
              items.map((t) => {
                const overdue = isTaskOverdue(t);
                const lead = t.leadId ? leads.find((l) => l.id === t.leadId) : null;
                return (
                  <div key={t.id} className={`task-row ${overdue ? 'overdue' : ''} ${t.concluida ? 'done' : ''}`}>
                    <button className="task-check" onClick={() => onToggleTask(t.id)} />
                    <div className="task-body">
                      <div className="task-title">{t.titulo}</div>
                      <div className="task-meta">
                        <span>{t.horario || 'sem horário'}</span>
                        {overdue && <span className="badge tag-overdue">ATRASADO</span>}
                        {lead && (
                          <span className="badge" style={{ background: PROD_COLOR[lead.produto] || 'var(--surface-2)', color: '#0a1628' }}>
                            {lead.produto}
                          </span>
                        )}
                      </div>
                    </div>
                    <button className="task-del" onClick={() => onDeleteTask(t.id)}>✕</button>
                  </div>
                );
              })
            )}
          </div>
        );
      })}
    </div>
  );
}
