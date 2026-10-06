import { useEffect, useMemo, useState } from 'react';
import { buildFollowUpQueue, sortDueFollowUps, sortWaitingFollowUps, sortBlockedFollowUps } from '../lib/followUpQueue.js';
import { FOLLOW_UP_POLICY } from '../lib/followUpEngine.js';
import {
  formatFollowUpReason, formatFollowUpTimeLabel, formatSuggestedAction,
  getOperationalBlockers, formatOperationalBlocker, hasMissingPhoneWarning,
  shouldShowAttemptCount, formatAttemptCount, shouldShowBlockedFollowUp,
} from '../lib/followUpPresentation.js';

// Fase 2C.2B — UI do Shadow Mode. Só recomenda: a única ação possível é
// abrir o LeadModal (via onEditLead) para o vendedor decidir o que fazer.
// Nenhum botão comercial (Ligar/WhatsApp/Criar tarefa) existe aqui.

const TABS = [
  { key: 'due', label: 'Precisa de ação' },
  { key: 'waiting', label: 'Aguardando' },
  { key: 'blocked', label: 'Bloqueados' },
];

const PAGE_SIZE = 20;

function DueCard({ item, onEditLead }) {
  const { lead, evaluation } = item;
  const reason = formatFollowUpReason(evaluation);
  const time = formatFollowUpTimeLabel(evaluation, item.now);
  const attempt = shouldShowAttemptCount(evaluation) ? formatAttemptCount(evaluation, FOLLOW_UP_POLICY) : null;
  const suggestedAction = formatSuggestedAction(evaluation);
  const missingPhone = hasMissingPhoneWarning(evaluation);
  const timeLine = [time, attempt].filter(Boolean).join(' · ');
  const etapaProduto = [lead.etapa, lead.produto].filter(Boolean).join(' · ');

  return (
    <button type="button" className="followup-card" onClick={() => onEditLead(lead)}>
      <div className="followup-card-top">
        <span className="followup-card-nome">{lead.nome}</span>
        <span className="badge badge-suggestion">Sugestão</span>
      </div>
      {reason && <div className="followup-card-reason">{reason.label}</div>}
      {reason && <div className="card-meta">{reason.subtitle}</div>}
      {timeLine && <div className="card-meta">{timeLine}</div>}
      {etapaProduto && <div className="card-meta">{etapaProduto}</div>}
      {suggestedAction && <div className="card-meta">Ação sugerida: {suggestedAction}</div>}
      {missingPhone && <div className="followup-warning">Sem telefone cadastrado</div>}
    </button>
  );
}

function WaitingCard({ item, onEditLead }) {
  const { lead, evaluation } = item;
  const reason = formatFollowUpReason(evaluation);
  const time = formatFollowUpTimeLabel(evaluation, item.now);
  const attempt = shouldShowAttemptCount(evaluation) ? formatAttemptCount(evaluation, FOLLOW_UP_POLICY) : null;
  const missingPhone = hasMissingPhoneWarning(evaluation);
  const timeLine = [time, attempt].filter(Boolean).join(' · ');

  return (
    <button type="button" className="followup-card compact" onClick={() => onEditLead(lead)}>
      <div className="followup-card-top">
        <span className="followup-card-nome">{lead.nome}</span>
      </div>
      {reason && <div className="followup-card-reason">{reason.label}</div>}
      {reason && <div className="card-meta">{reason.subtitle}</div>}
      {timeLine && <div className="card-meta">{timeLine}</div>}
      {missingPhone && <div className="followup-warning">Sem telefone cadastrado</div>}
    </button>
  );
}

function BlockedCard({ item, onEditLead }) {
  const { lead, evaluation } = item;
  const operationalBlockers = getOperationalBlockers(evaluation);

  return (
    <button type="button" className="followup-card compact" onClick={() => onEditLead(lead)}>
      <div className="followup-card-top">
        <span className="followup-card-nome">{lead.nome}</span>
      </div>
      {operationalBlockers.map((code) => (
        <div className="card-meta" key={code}>{formatOperationalBlocker(code)}</div>
      ))}
    </button>
  );
}

const EMPTY_MESSAGES = {
  due: 'Nenhum follow-up pendente agora.',
  waiting: 'Nenhum follow-up aguardando janela.',
  blocked: 'Nenhum follow-up bloqueado.',
};

export default function FollowUpQueue({ leads, interactions, tasks, interactionsLoading, interactionsError, now, onEditLead, onRetryInteractions }) {
  const [tab, setTab] = useState('due');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  useEffect(() => { setVisibleCount(PAGE_SIZE); }, [tab]);

  const queue = useMemo(
    () => buildFollowUpQueue({ leads, interactions, tasks, now, policy: FOLLOW_UP_POLICY }),
    [leads, interactions, tasks, now],
  );

  const dueItems = useMemo(() => sortDueFollowUps(queue), [queue]);
  const waitingItems = useMemo(() => sortWaitingFollowUps(queue), [queue]);
  // Oculta blocked puramente estrutural (Ganho/Perdido/deleted) — mesmo
  // quando também carrega um blocker operacional residual, ver
  // shouldShowBlockedFollowUp (Fase 2C.2B.1). O motor continua avaliando
  // tudo (buildFollowUpQueue não filtra nada), só a apresentação decide
  // o que mostrar na aba "Bloqueados" — e esta é a ÚNICA lista usada
  // tanto para os cards quanto para o contador da aba (abaixo), nunca
  // duas fontes divergentes.
  const blockedItems = useMemo(
    () => sortBlockedFollowUps(queue).filter((item) => shouldShowBlockedFollowUp(item.evaluation)),
    [queue],
  );
  const errorCount = useMemo(() => queue.filter((item) => item.error).length, [queue]);

  const itemsByTab = { due: dueItems, waiting: waitingItems, blocked: blockedItems };
  const activeItems = itemsByTab[tab];
  const visibleItems = activeItems.slice(0, visibleCount);
  const CardByTab = { due: DueCard, waiting: WaitingCard, blocked: BlockedCard };
  const ActiveCard = CardByTab[tab];

  return (
    <section className="followup-section">
      <h2 className="section-title" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>Follow-ups sugeridos</h2>
      <p className="followup-subtitle">Recomendações baseadas na atividade dos seus leads.</p>

      {interactionsLoading && <div className="empty-state">Calculando sugestões...</div>}

      {!interactionsLoading && interactionsError && (
        <div className="empty-state" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
          Não foi possível carregar as sugestões de follow-up.
          <div style={{ marginTop: 8 }}>
            <button type="button" className="icon-btn" onClick={onRetryInteractions}>Tentar novamente</button>
          </div>
        </div>
      )}

      {!interactionsLoading && !interactionsError && (
        <>
          <div className="filters">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`chip ${tab === t.key ? 'active' : ''}`}
                onClick={() => setTab(t.key)}
              >
                {t.label} ({itemsByTab[t.key].length})
              </button>
            ))}
          </div>

          {errorCount > 0 && (
            <div className="card-meta" style={{ marginBottom: 10 }}>
              ⚠ {errorCount === 1 ? '1 lead não pôde ser avaliado.' : `${errorCount} leads não puderam ser avaliados.`}
            </div>
          )}

          {activeItems.length === 0 ? (
            <div className="empty-state">{EMPTY_MESSAGES[tab]}</div>
          ) : (
            <div className="followup-list">
              {visibleItems.map((item) => (
                <ActiveCard key={item.lead.id} item={{ ...item, now }} onEditLead={onEditLead} />
              ))}
            </div>
          )}

          {activeItems.length > visibleCount && (
            <button type="button" className="icon-btn" style={{ marginTop: 8 }} onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}>
              Mostrar mais
            </button>
          )}
        </>
      )}
    </section>
  );
}
