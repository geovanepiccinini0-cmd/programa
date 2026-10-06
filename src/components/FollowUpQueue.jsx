import { useEffect, useMemo, useState } from 'react';
import { buildFollowUpQueue, sortDueFollowUps, sortWaitingFollowUps, sortBlockedFollowUps } from '../lib/followUpQueue.js';
import { FOLLOW_UP_POLICY } from '../lib/followUpEngine.js';
import { buildTelHref } from '../lib/followUpAction.js';
import { useCommercialRegistration } from '../hooks/useCommercialRegistration.js';
import {
  formatFollowUpReason, formatFollowUpTimeLabel, formatSuggestedAction,
  getOperationalBlockers, formatOperationalBlocker, hasMissingPhoneWarning,
  shouldShowAttemptCount, formatAttemptCount, shouldShowBlockedFollowUp,
} from '../lib/followUpPresentation.js';

// Fase 2C.2B — UI do Shadow Mode. Só recomenda: a ação comercial sempre
// exige confirmação explícita do vendedor.
//
// Fase 2D.1 — primeira ação assistida real (só "Ligar"): abrir `tel:`
// NUNCA registra nada sozinho — é só um atalho de conveniência. O
// resultado comercial (call_connected/call_no_answer) só é registrado
// quando o vendedor confirma explicitamente no picker que aparece depois
// de "Ligar". "Cancelar" não registra nada. WhatsApp/reunião/proposta
// continuam só texto nesta fase (ver investigação 2D.0).

const TABS = [
  { key: 'due', label: 'Precisa de ação' },
  { key: 'waiting', label: 'Aguardando' },
  { key: 'blocked', label: 'Bloqueados' },
];

const PAGE_SIZE = 20;

// Fase 2D.1 — picker de resultado pós-"Ligar". Não decide nada sozinho:
// cada botão só dispara o callback do pai (que chama
// useCommercialRegistration.register ou só fecha, no caso de Cancelar).
function CallResultPicker({ registering, error, onResult, onCancel }) {
  return (
    <div className="followup-call-picker">
      <div className="followup-card-actions">
        <button type="button" className="chip" disabled={registering} onClick={() => onResult('call_connected')}>Atendeu</button>
        <button type="button" className="chip" disabled={registering} onClick={() => onResult('call_no_answer')}>Não atendeu</button>
        <button type="button" className="chip" disabled={registering} onClick={onCancel}>Cancelar</button>
      </div>
      {error && <div className="followup-warning">{error}</div>}
    </div>
  );
}

function DueCard({ item, onEditLead, assistedCallLeadId, callRegistering, callError, onStartCall, onCallResult, onCancelCall }) {
  const { lead, evaluation } = item;
  const reason = formatFollowUpReason(evaluation);
  const time = formatFollowUpTimeLabel(evaluation, item.now);
  const attempt = shouldShowAttemptCount(evaluation) ? formatAttemptCount(evaluation, FOLLOW_UP_POLICY) : null;
  const suggestedAction = formatSuggestedAction(evaluation);
  const missingPhone = hasMissingPhoneWarning(evaluation);
  const timeLine = [time, attempt].filter(Boolean).join(' · ');
  const etapaProduto = [lead.etapa, lead.produto].filter(Boolean).join(' · ');

  // Fase 2D.1 — só "call" ganha CTA executável nesta fase (whatsapp/
  // meeting/proposal continuam só texto, ver investigação 2D.0). Sem
  // telefone utilizável -> buildTelHref devolve null -> sem CTA, sem
  // botão desabilitado (mesma decisão já tomada para o resto do card:
  // o aviso "Sem telefone cadastrado" abaixo já é suficiente).
  const isCallSuggested = evaluation.suggestedAction && evaluation.suggestedAction.type === 'call';
  const telHref = isCallSuggested ? buildTelHref(lead.telefone) : null;
  const isAssistingThisLead = assistedCallLeadId === lead.id;

  return (
    <div className="followup-card">
      {/* Fase 2D.1 — o card deixou de ser um único <button> porque agora
          pode conter um botão de ação real ("Ligar") ao lado do corpo
          clicável — botão dentro de botão é HTML inválido e quebra
          acessibilidade. A região informativa vira seu próprio <button>
          (reset visual via .followup-card-open, mesma aparência de
          antes), e "Ligar"/o picker ficam como irmãos dele, nunca
          aninhados — então nenhum clique neles propaga para o
          onEditLead, sem precisar de stopPropagation. */}
      <button type="button" className="followup-card-open" onClick={() => onEditLead(lead)}>
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
      {telHref && !isAssistingThisLead && (
        <div className="followup-card-actions">
          <a href={telHref} className="icon-btn" onClick={() => onStartCall(lead.id)}>Ligar</a>
        </div>
      )}
      {isAssistingThisLead && (
        <CallResultPicker
          registering={callRegistering}
          error={callError}
          onResult={(actionKey) => onCallResult(lead.id, actionKey)}
          onCancel={() => onCancelCall(lead.id)}
        />
      )}
    </div>
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

export default function FollowUpQueue({
  leads, interactions, tasks, interactionsLoading, interactionsError, now,
  onEditLead, onRetryInteractions, onRegisterCommercialInteraction,
}) {
  const [tab, setTab] = useState('due');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  // Fase 2D.1 — qual lead (no máximo um por vez) está com o picker de
  // ligação aberto. Vive aqui (no pai), não dentro de DueCard: se a fila
  // recalcular e esse lead sumir da aba due, o card desmonta mas este
  // state sobrevive — o efeito abaixo o limpa de forma previsível, sem
  // crash e sem registrar nada sozinho.
  const [assistedCallLeadId, setAssistedCallLeadId] = useState(null);
  const { registering: callRegistering, error: callError, register: registerCall, clearError: clearCallError } = useCommercialRegistration(onRegisterCommercialInteraction);

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

  // Fase 2D.1 — se o lead que estava com o picker aberto sumir da fila
  // due (ex.: a fila recalculou por outro motivo enquanto o picker
  // estava aberto), limpa o state em vez de deixá-lo "pendurado" sem
  // card correspondente. Nunca registra nada por conta própria aqui.
  useEffect(() => {
    if (assistedCallLeadId && !dueItems.some((item) => item.lead.id === assistedCallLeadId)) {
      setAssistedCallLeadId(null);
    }
  }, [dueItems, assistedCallLeadId]);

  function handleStartCall(leadId) {
    if (assistedCallLeadId !== leadId) clearCallError();
    setAssistedCallLeadId(leadId);
  }

  function handleCancelCall(leadId) {
    if (assistedCallLeadId !== leadId) return;
    setAssistedCallLeadId(null);
    clearCallError();
  }

  async function handleCallResult(leadId, actionKey) {
    try {
      const inserted = await registerCall(leadId, actionKey);
      if (!inserted) return; // guard de duplo clique (register já em andamento)
      setAssistedCallLeadId(null);
      // interactions central já atualiza dentro de registerCommercialInteraction
      // (useAppState.js) — a fila recalcula sozinha a partir da prop, sem
      // atualização manual paralela aqui.
    } catch (e) {
      // erro já populado em callError pelo hook; picker permanece aberto
      // (continua montado porque o lead, por enquanto, ainda está em due).
    }
  }

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
                <ActiveCard
                  key={item.lead.id}
                  item={{ ...item, now }}
                  onEditLead={onEditLead}
                  assistedCallLeadId={assistedCallLeadId}
                  callRegistering={callRegistering}
                  callError={callError}
                  onStartCall={handleStartCall}
                  onCallResult={handleCallResult}
                  onCancelCall={handleCancelCall}
                />
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
