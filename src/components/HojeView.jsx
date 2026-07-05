import { useMemo, useState } from 'react';
import { CATS_TASK } from '../constants.js';
import { todayStr, tomorrowStr } from '../utils.js';
import TaskGroupedList from './TaskGroupedList.jsx';
import WeekAgenda from './WeekAgenda.jsx';

export default function HojeView({ leads, tasks, onAddTask, onToggleTask, onDeleteTask }) {
  const [title, setTitle] = useState('');
  const [cat, setCat] = useState(CATS_TASK[0]);
  const [date, setDate] = useState(todayStr());
  const [time, setTime] = useState('');

  const today = todayStr();
  const tomorrow = tomorrowStr();

  const todayTasks = useMemo(() => tasks.filter((t) => t.data === today), [tasks, today]);
  const tomorrowTasks = useMemo(() => tasks.filter((t) => t.data === tomorrow), [tasks, tomorrow]);

  function handleAdd() {
    const trimmed = title.trim();
    if (!trimmed) return;
    onAddTask(trimmed, cat, date || todayStr(), time);
    setTitle('');
    setTime('');
  }

  return (
    <section className="view active">
      <div className="add-task-form">
        <input
          type="text"
          placeholder="Nova tarefa (ex: gravar reels sobre home equity)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
        />
        <select value={cat} onChange={(e) => setCat(e.target.value)}>
          {CATS_TASK.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        <button className="btn-primary" onClick={handleAdd}>Adicionar</button>
      </div>

      <h2 className="section-title">Hoje</h2>
      <TaskGroupedList
        tasks={todayTasks}
        leads={leads}
        onToggleTask={onToggleTask}
        onDeleteTask={onDeleteTask}
        emptyMessage="Nenhuma tarefa para hoje. Adicione a primeira acima ou cadastre um lead com data de próximo contato."
      />

      <h2 className="section-title">Amanhã</h2>
      <TaskGroupedList
        tasks={tomorrowTasks}
        leads={leads}
        onToggleTask={onToggleTask}
        onDeleteTask={onDeleteTask}
        emptyMessage="Nenhuma tarefa para amanhã ainda."
      />

      <h2 className="section-title">Agenda da semana</h2>
      <WeekAgenda
        tasks={tasks}
        leads={leads}
        onToggleTask={onToggleTask}
        onDeleteTask={onDeleteTask}
      />
    </section>
  );
}
