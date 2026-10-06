import { useState } from 'react';
import { shouldOfferResultCapture } from '../hooks/useAppState.js';

// Fase 2A.3 — picker contextual de resultado, compartilhado entre
// TaskGroupedList e WeekAgenda (os dois renderizam a linha da tarefa de
// forma independente). Só tarefas lead-agenda pendentes oferecem a
// escolha; qualquer outra tarefa mantém o clique direto de sempre.
const RESULT_OPTIONS = [
  { actionKey: 'call_connected', label: 'Atendeu' },
  { actionKey: 'call_no_answer', label: 'Não atendeu' },
];

export default function TaskCompletionControl({ task, onToggleTask, onCompleteWithResult }) {
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const offerResult = !task.concluida && shouldOfferResultCapture(task);

  function handleCheckClick() {
    // Desmarcar (tarefa já concluída) ou tarefa que não oferece resultado:
    // comportamento atual direto, nunca abre o picker.
    if (task.concluida || !offerResult) {
      onToggleTask(task.id);
      return;
    }
    setError('');
    setPicking(true);
  }

  async function runGuarded(action) {
    if (submitting) return;
    setSubmitting(true);
    setError('');
    try {
      await action();
      setPicking(false);
    } catch (e) {
      // Mantém o picker aberto para nova tentativa; nunca finge sucesso.
      setError(e.message || 'Falha inesperada.');
    } finally {
      setSubmitting(false);
    }
  }

  if (!picking) {
    return <button className="task-check" onClick={handleCheckClick} />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div className="filters" style={{ marginBottom: 0 }}>
        {RESULT_OPTIONS.map((opt) => (
          <button
            type="button"
            key={opt.actionKey}
            className="chip"
            disabled={submitting}
            onClick={() => runGuarded(() => onCompleteWithResult(task.id, opt.actionKey))}
          >
            {opt.label}
          </button>
        ))}
        <button type="button" className="chip" disabled={submitting} onClick={() => runGuarded(() => onToggleTask(task.id))}>
          Só concluir
        </button>
        <button type="button" className="chip" disabled={submitting} onClick={() => setPicking(false)}>
          ✕
        </button>
      </div>
      {error && <div style={{ fontSize: 11, color: 'var(--red)' }}>{error}</div>}
    </div>
  );
}
