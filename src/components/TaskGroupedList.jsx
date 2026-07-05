import { useMemo } from 'react';
import { CATS_TASK, PROD_COLOR } from '../constants.js';
import { fmtDate, isTaskOverdue } from '../utils.js';

export default function TaskGroupedList({ tasks, leads, onToggleTask, onDeleteTask, emptyMessage }) {
  const groups = useMemo(() => {
    const g = {};
    CATS_TASK.forEach((c) => { g[c] = []; });
    tasks.forEach((t) => {
      if (!g[t.categoria]) g[t.categoria] = [];
      g[t.categoria].push(t);
    });
    CATS_TASK.forEach((c) => {
      g[c] = g[c].slice().sort((a, b) => {
        const da = (a.data || '9999') + 'T' + (a.horario || '99:99');
        const db = (b.data || '9999') + 'T' + (b.horario || '99:99');
        return da.localeCompare(db);
      });
    });
    return g;
  }, [tasks]);

  if (tasks.length === 0) {
    return <div className="empty-state">{emptyMessage}</div>;
  }

  return (
    <div>
      {CATS_TASK.map((catName) => {
        const items = groups[catName] || [];
        if (items.length === 0) return null;
        return (
          <div className="task-group" key={catName}>
            <h3>{catName}</h3>
            {items.map((t) => {
              const overdue = isTaskOverdue(t);
              const lead = t.leadId ? leads.find((l) => l.id === t.leadId) : null;
              return (
                <div key={t.id} className={`task-row ${overdue ? 'overdue' : ''} ${t.concluida ? 'done' : ''}`}>
                  <button className="task-check" onClick={() => onToggleTask(t.id)} />
                  <div className="task-body">
                    <div className="task-title">{t.titulo}</div>
                    <div className="task-meta">
                      <span>{fmtDate(t.data)}{t.horario ? ' · ' + t.horario : ''}</span>
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
            })}
          </div>
        );
      })}
    </div>
  );
}
