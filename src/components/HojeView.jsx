import { useMemo, useState } from 'react';
import { CATS_TASK } from '../constants.js';
import { todayStr, tomorrowStr } from '../utils.js';
import TaskGroupedList from './TaskGroupedList.jsx';
import WeekAgenda from './WeekAgenda.jsx';
import FollowUpQueue from './FollowUpQueue.jsx';
import StaleLeadsAlert from './StaleLeadsAlert.jsx';
import FollowUpPolicySettings from './FollowUpPolicySettings.jsx';
import AutoStageTaskFailuresAlert from './AutoStageTaskFailuresAlert.jsx';

export default function HojeView({
  leads, tasks, onAddTask, onToggleTask, onDeleteTask, onCompleteWithResult,
  interactions, interactionsLoading, interactionsError, now, onEditLead, onRetryInteractions,
  onRegisterCommercialInteraction,
  stagePoliciesLoading, stagePoliciesError, onRetryStagePolicies,
  stagePolicyOverrides, onSaveStagePolicy, onRemoveStagePolicy,
  snoozesByLead, onSaveSnooze, onRemoveSnooze,
  snoozesLoading, snoozesError, onRetrySnoozes,
  autoStageTaskFailures, onRetryAutoStageTask, onDismissAutoStageTaskFailure,
}) {
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
      {/* Etapa D (correção pós-revisão do PR #76) — aviso de falha na
          automação, acima de tudo: o requisito prioritário é "nunca
          passar despercebido", então fica visível antes mesmo da
          configuração de política/fila de follow-up. */}
      <AutoStageTaskFailuresAlert
        failures={autoStageTaskFailures}
        onRetry={onRetryAutoStageTask}
        onDismiss={onDismissAutoStageTaskFailure}
      />

      {/* Etapa B — configuração de prazos por etapa (migration 026).
          Nunca cria task/interação por si só: só grava a configuração,
          que o motor lê na próxima avaliação (stagePolicyOverrides,
          já refletido em FollowUpQueue abaixo). */}
      <FollowUpPolicySettings
        stagePolicyOverrides={stagePolicyOverrides}
        loading={stagePoliciesLoading}
        error={stagePoliciesError}
        onRetry={onRetryStagePolicies}
        onSave={onSaveStagePolicy}
        onRemove={onRemoveStagePolicy}
      />

      <FollowUpQueue
        leads={leads}
        interactions={interactions}
        tasks={tasks}
        interactionsLoading={interactionsLoading}
        interactionsError={interactionsError}
        now={now}
        onEditLead={onEditLead}
        onRetryInteractions={onRetryInteractions}
        onRegisterCommercialInteraction={onRegisterCommercialInteraction}
        stagePolicyOverrides={stagePolicyOverrides}
        snoozesByLead={snoozesByLead}
        onSaveSnooze={onSaveSnooze}
        onRemoveSnooze={onRemoveSnooze}
        snoozesLoading={snoozesLoading}
        snoozesError={snoozesError}
        onRetrySnoozes={onRetrySnoozes}
      />

      {/* Etapa A — bloco independente da fila de follow-up acima:
          "parado" (sem atualização de cadastro) nunca é a mesma coisa
          que "follow-up vencido" (atividade comercial), ver
          StaleLeadsAlert.jsx. Nunca cria tarefa, só leitura + atalho
          para abrir o cadastro (onEditLead, mesmo fluxo já usado em
          toda a aplicação). */}
      <StaleLeadsAlert leads={leads} onEditLead={onEditLead} />

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
        onCompleteWithResult={onCompleteWithResult}
        emptyMessage="Nenhuma tarefa para hoje. Adicione a primeira acima ou cadastre um lead com data de próximo contato."
      />

      <h2 className="section-title">Amanhã</h2>
      <TaskGroupedList
        tasks={tomorrowTasks}
        leads={leads}
        onToggleTask={onToggleTask}
        onDeleteTask={onDeleteTask}
        onCompleteWithResult={onCompleteWithResult}
        emptyMessage="Nenhuma tarefa para amanhã ainda."
      />

      <h2 className="section-title">Agenda da semana</h2>
      <WeekAgenda
        tasks={tasks}
        leads={leads}
        onToggleTask={onToggleTask}
        onDeleteTask={onDeleteTask}
        onCompleteWithResult={onCompleteWithResult}
      />
    </section>
  );
}
