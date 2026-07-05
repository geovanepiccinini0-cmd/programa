import { useState } from 'react';
import { CATS_TASK, DIAS_SEMANA } from '../constants.js';

export default function RotinaView({ templates, onAddRotina, onToggleAtiva, onDeleteRotina }) {
  const [title, setTitle] = useState('');
  const [cat, setCat] = useState(CATS_TASK[0]);
  const [time, setTime] = useState('');
  const [selectedDias, setSelectedDias] = useState([]);

  function toggleDay(d) {
    setSelectedDias((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  }

  function handleAdd() {
    const trimmed = title.trim();
    if (!trimmed) return;
    if (selectedDias.length === 0) {
      alert('Escolha pelo menos um dia da semana para essa rotina.');
      return;
    }
    onAddRotina(trimmed, cat, time, selectedDias);
    setTitle('');
    setTime('');
    setSelectedDias([]);
  }

  return (
    <section className="view active">
      <div className="add-task-form" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Nome da tarefa recorrente (ex: Gravar reels)"
            style={{ flex: 2, minWidth: 220 }}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <select value={cat} onChange={(e) => setCat(e.target.value)}>
            {CATS_TASK.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        </div>
        <div className="filters" style={{ margin: '12px 0 0' }}>
          {DIAS_SEMANA.map((d) => (
            <button
              type="button"
              key={d}
              className={`chip ${selectedDias.includes(d) ? 'active' : ''}`}
              onClick={() => toggleDay(d)}
            >
              {d}
            </button>
          ))}
        </div>
        <button className="btn-primary" style={{ alignSelf: 'flex-start', marginTop: 12 }} onClick={handleAdd}>
          + Adicionar rotina
        </button>
      </div>

      <div>
        {templates.length === 0 ? (
          <div className="empty-state">
            Nenhuma rotina cadastrada ainda. Cadastre acima os dias em que grava reels, posta, alimenta o marketplace, etc — o sistema lança a tarefa sozinho no dia certo.
          </div>
        ) : (
          templates.map((tpl) => (
            <div className={`task-row ${tpl.ativo ? '' : 'done'}`} key={tpl.id}>
              <button className="task-check" onClick={() => onToggleAtiva(tpl.id)}>{tpl.ativo ? '✓' : ''}</button>
              <div className="task-body">
                <div className="task-title">{tpl.titulo}</div>
                <div className="task-meta">
                  <span className="badge" style={{ background: 'var(--surface-2)', color: 'var(--text)' }}>{tpl.categoria}</span>
                  {tpl.horario && <span>{tpl.horario}</span>}
                  <span>{tpl.dias.join(', ')}</span>
                </div>
              </div>
              <button className="task-del" onClick={() => onDeleteRotina(tpl.id)}>✕</button>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
