import { useState } from 'react';

// Etapa D (correção pós-revisão do PR #76, achado 1 — "uma falha na
// automação nunca pode passar despercebida"). Puramente apresentacional:
// `failures` já vem pronto de useAppState.js (autoStageTaskFailures,
// persistido por usuário em localStorage — sobrevive a um reload antes
// do vendedor notar/agir). Este componente nunca decide o que é uma
// falha, nunca escreve nada sozinho — só mostra e dispara os callbacks.
//
// "Tentar novamente" reusa exatamente os dados da tentativa que falhou
// (retryAutoStageTaskCreation, useAppState.js) — nunca recalcula do
// zero, e nunca cria duplicata (confere de novo contra o estado atual
// de `tasks` antes de reinserir, e a escrita em si continua protegida
// pelo índice único da migration 028). "Descartar" só remove o aviso,
// sem nenhuma escrita.
export default function AutoStageTaskFailuresAlert({ failures, onRetry, onDismiss }) {
  const [retryingKey, setRetryingKey] = useState(null);

  if (!failures || failures.length === 0) return null;

  async function handleRetry(key) {
    setRetryingKey(key);
    try {
      await onRetry(key);
    } finally {
      setRetryingKey((prev) => (prev === key ? null : prev));
    }
  }

  return (
    <section className="followup-section" aria-label="Falhas ao criar tarefas automáticas" style={{ borderColor: 'var(--red)' }}>
      <h2 className="section-title" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none', color: 'var(--red)' }}>
        Tarefas automáticas não criadas ({failures.length})
      </h2>
      <p className="followup-subtitle">
        A mudança de etapa foi salva normalmente, mas a tarefa automática correspondente não pôde ser criada. Tente novamente ou descarte se já resolveu manualmente.
      </p>
      <div className="followup-list">
        {failures.map((f) => {
          const isRetrying = retryingKey === f.key;
          return (
            <div className="followup-card compact" key={f.key}>
              <div className="followup-card-top">
                <span className="followup-card-nome">{f.leadNome || 'Lead'}</span>
              </div>
              <div className="card-meta">Etapa: {f.etapa}</div>
              <div className="followup-warning">{f.error}</div>
              <div className="followup-card-actions">
                <button type="button" className="btn-primary" disabled={isRetrying} onClick={() => handleRetry(f.key)}>
                  {isRetrying ? 'Tentando...' : 'Tentar novamente'}
                </button>
                <button type="button" className="icon-btn" disabled={isRetrying} onClick={() => onDismiss(f.key)}>
                  Descartar
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
