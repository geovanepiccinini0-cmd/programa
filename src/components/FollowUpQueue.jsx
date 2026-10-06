import { useEffect, useMemo, useState } from 'react';
import { buildFollowUpQueue, sortDueFollowUps, sortWaitingFollowUps, sortBlockedFollowUps } from '../lib/followUpQueue.js';
import { FOLLOW_UP_POLICY } from '../lib/followUpEngine.js';
import { buildTelHref, buildWhatsAppHref } from '../lib/followUpAction.js';
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
// de "Ligar". "Cancelar" não registra nada.
//
// Fase 2D.2.B — segunda ação assistida (WhatsApp), mesmo contrato:
// abrir wa.me NUNCA registra `whatsapp_sent` sozinho. Reutiliza
// integralmente buildWhatsAppHref (2D.2.A, normalização rígida própria
// de WhatsApp — nunca duplicada aqui) e a mesma instância de
// useCommercialRegistration já usada pela ligação — só um picker
// assistido pode estar aberto por vez (assistedLeadId), e o motor nunca
// sugere `call` e `whatsapp` para o mesmo lead simultaneamente, então
// não há risco de uma ação pisar na outra. Reunião/proposta continuam
// só texto nesta fase (ver investigação 2D.0/2D.2.0).

const TABS = [
  { key: 'due', label: 'Precisa de ação' },
  { key: 'waiting', label: 'Aguardando' },
  { key: 'blocked', label: 'Bloqueados' },
];

const PAGE_SIZE = 20;

// Fase 2D.2.C.1 — mapa de coerência tipo-congelado -> actionKey
// permitido (ver handleAssistedResult). Módulo-level: estático, não
// depende de nenhuma prop/state.
const ASSISTED_RESULT_ACTIONS = { call: ['call_connected', 'call_no_answer'], whatsapp: ['whatsapp_sent'] };

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

// Fase 2D.2.B — picker de resultado pós-"WhatsApp". Mesmo contrato do
// CallResultPicker (nenhum botão decide nada sozinho, só dispara o
// callback do pai), mas com só 2 estados possíveis — nunca um
// "Cliente respondeu" aqui: resposta inbound é fato distinto, só
// registrável quando realmente ocorrer, exclusivamente no LeadTimeline
// (ver investigação 2D.2.0, seção 18). Também não existe um "Não
// enviei" separado de Cancelar: diferente de uma ligação atendida vs.
// não atendida (dois FATOS distintos sobre uma ligação que de fato
// ocorreu), não enviar a mensagem é equivalente a nunca ter aberto o
// WhatsApp — zero interaction, Cancelar já cobre isso integralmente.
function WhatsAppResultPicker({ registering, error, onResult, onCancel }) {
  return (
    <div className="followup-call-picker">
      <div className="followup-card-actions">
        <button type="button" className="chip" disabled={registering} onClick={() => onResult('whatsapp_sent')}>Mensagem enviada</button>
        <button type="button" className="chip" disabled={registering} onClick={onCancel}>Cancelar</button>
      </div>
      {error && <div className="followup-warning">{error}</div>}
    </div>
  );
}

function DueCard({ item, onEditLead, assistedAction, assistedRegistering, assistedError, onStartAssisted, onAssistedResult, onCancelAssisted }) {
  const { lead, evaluation } = item;
  const reason = formatFollowUpReason(evaluation);
  const time = formatFollowUpTimeLabel(evaluation, item.now);
  const attempt = shouldShowAttemptCount(evaluation) ? formatAttemptCount(evaluation, FOLLOW_UP_POLICY) : null;
  const suggestedAction = formatSuggestedAction(evaluation);
  const missingPhone = hasMissingPhoneWarning(evaluation);
  const timeLine = [time, attempt].filter(Boolean).join(' · ');
  const etapaProduto = [lead.etapa, lead.produto].filter(Boolean).join(' · ');

  // Fase 2D.1/2D.2.B — só "call"/"whatsapp" ganham CTA executável nesta
  // fase (meeting/proposal continuam só texto, ver investigação 2D.0).
  // O motor nunca sugere os dois tipos ao mesmo tempo para o mesmo lead
  // (suggestedAction.type é um valor único), então isCallSuggested e
  // isWhatsappSuggested são sempre mutuamente exclusivos — nunca os dois
  // CTAs aparecem juntos. Sem telefone utilizável -> builder devolve
  // null -> sem CTA, sem botão desabilitado (mesma decisão já tomada
  // para o resto do card: o aviso "Sem telefone cadastrado" abaixo já é
  // suficiente). buildWhatsAppHref é bem mais rígido que buildTelHref
  // (ver 2D.2.A) — pode recusar um telefone que buildTelHref aceitaria;
  // isso nunca é tratado como erro aqui, só como "sem CTA". Isto decide
  // SÓ se a CTA aparece agora — nunca decide qual picker renderizar
  // (ver 2D.2.C.1 abaixo, assistedAction.type é quem decide isso).
  const isCallSuggested = evaluation.suggestedAction && evaluation.suggestedAction.type === 'call';
  const isWhatsappSuggested = evaluation.suggestedAction && evaluation.suggestedAction.type === 'whatsapp';
  const telHref = isCallSuggested ? buildTelHref(lead.telefone) : null;
  const waHref = isWhatsappSuggested ? buildWhatsAppHref(lead.telefone) : null;
  // Fase 2D.2.C.1 — qual picker aparece depende do TIPO CONGELADO no
  // momento do clique (assistedAction.type), nunca da suggestedAction
  // atual do motor — ver o efeito de invalidação em FollowUpQueue, que
  // fecha o picker (nunca troca de tipo) se a sugestão mudar antes da
  // confirmação.
  const isAssistingThisLead = Boolean(assistedAction) && assistedAction.leadId === lead.id;

  return (
    <div className="followup-card">
      {/* Fase 2D.1 — o card deixou de ser um único <button> porque agora
          pode conter um botão de ação real ("Ligar"/"WhatsApp") ao lado
          do corpo clicável — botão dentro de botão é HTML inválido e
          quebra acessibilidade. A região informativa vira seu próprio
          <button> (reset visual via .followup-card-open, mesma
          aparência de antes), e a CTA/o picker ficam como irmãos dele,
          nunca aninhados — então nenhum clique neles propaga para o
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
          <a href={telHref} className="icon-btn" onClick={() => onStartAssisted(lead.id, 'call')}>Ligar</a>
        </div>
      )}
      {waHref && !isAssistingThisLead && (
        <div className="followup-card-actions">
          {/* Fase 2D.2.B — target="_blank"+rel="noopener noreferrer":
              diferente de tel: (que o SO intercepta sem nunca carregar
              página na aba), wa.me é uma URL http(s) real — sem isso, a
              própria aba do CRM navegaria para fora caso não haja app/
              protocolo instalado (ver investigação 2D.2.0). */}
          <a href={waHref} className="icon-btn" target="_blank" rel="noopener noreferrer" onClick={() => onStartAssisted(lead.id, 'whatsapp')}>WhatsApp</a>
        </div>
      )}
      {/* Fase 2D.2.C.1 — picker escolhido por assistedAction.type
          (congelado no clique), nunca por isCallSuggested/isWhatsappSuggested
          (que refletem a sugestão ATUAL do motor, podendo já ter mudado). */}
      {isAssistingThisLead && assistedAction.type === 'call' && (
        <CallResultPicker
          registering={assistedRegistering}
          error={assistedError}
          onResult={(actionKey) => onAssistedResult(lead.id, actionKey)}
          onCancel={() => onCancelAssisted(lead.id)}
        />
      )}
      {isAssistingThisLead && assistedAction.type === 'whatsapp' && (
        <WhatsAppResultPicker
          registering={assistedRegistering}
          error={assistedError}
          onResult={(actionKey) => onAssistedResult(lead.id, actionKey)}
          onCancel={() => onCancelAssisted(lead.id)}
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
  // Fase 2D.1 — qual lead (no máximo um por vez) está com o picker
  // assistido aberto. Vive aqui (no pai), não dentro de DueCard: se a
  // fila recalcular e esse lead sumir da aba due, o card desmonta mas
  // este state sobrevive — o efeito abaixo o limpa de forma previsível,
  // sem crash e sem registrar nada sozinho.
  //
  // Fase 2D.2.B generalizou para `assistedLeadId` (só o id). A 2D.2.C.1
  // corrigiu um BLOCKER-class HIGH encontrado na auditoria: com só o
  // leadId, o picker certo (Call/WhatsApp) era escolhido a cada render
  // pela suggestedAction ATUAL do motor — se o vendedor editasse a
  // "Próxima ação" do mesmo lead no LeadModal (alcançável: o corpo do
  // card continua clicável com o picker aberto) ANTES de confirmar, o
  // picker podia trocar de tipo silenciosamente (ex. abriu WhatsApp,
  // confirma "Atendeu" de uma ligação que nunca ocorreu). Por isso o
  // state agora congela `{ leadId, type }` no momento exato do clique
  // na CTA — representa "a ação que o vendedor efetivamente iniciou",
  // nunca "a sugestão atual". O efeito de invalidação abaixo fecha o
  // picker (nunca troca de tipo, nunca registra nada) se a sugestão ou
  // a executabilidade mudarem antes da confirmação. Continua um único
  // state (não dois paralelos) e uma ÚNICA instância do hook abaixo
  // serve as duas ações — só pode haver um registro assistido em
  // andamento por vez nesta UI.
  const [assistedAction, setAssistedAction] = useState(null);
  const {
    registering: assistedRegistering, error: assistedError,
    register: registerAssistedAction, clearError: clearAssistedError,
  } = useCommercialRegistration(onRegisterCommercialInteraction);

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

  // Fase 2D.2.C.1 — invalidação da ação assistida. Três motivos para
  // fechar o picker, SEMPRE fechando (nunca trocando de tipo, nunca
  // registrando nada):
  // 1) o lead saiu de due (mesma proteção da 2D.1/2D.2.B);
  // 2) a suggestedAction do motor para esse lead deixou de ser do
  //    MESMO tipo que foi congelado no clique (ex.: vendedor trocou a
  //    "Próxima ação" no LeadModal de whatsapp para call enquanto o
  //    picker de WhatsApp estava aberto — o motor agora sugere call,
  //    mas a ação que o vendedor efetivamente iniciou foi whatsapp;
  //    nunca mostramos o picker de call aqui, só fechamos);
  // 3) a ação congelada deixou de ser executável (telefone mudou para
  //    algo que buildTelHref/buildWhatsAppHref não aceita mais).
  // Em QUALQUER um dos três casos: fecha, usuário precisa iniciar de
  // novo a ação correspondente ao estado atual, se ainda fizer sentido.
  useEffect(() => {
    if (!assistedAction) return;
    const current = dueItems.find((item) => item.lead.id === assistedAction.leadId);
    if (!current) {
      setAssistedAction(null);
      return;
    }
    if (!current.evaluation.suggestedAction || current.evaluation.suggestedAction.type !== assistedAction.type) {
      setAssistedAction(null);
      return;
    }
    const stillExecutable = assistedAction.type === 'call'
      ? Boolean(buildTelHref(current.lead.telefone))
      : Boolean(buildWhatsAppHref(current.lead.telefone));
    if (!stillExecutable) setAssistedAction(null);
  }, [dueItems, assistedAction]);

  // Fase 2D.2.C.1 — o clique na CTA congela o tipo junto com o leadId:
  // `type` só pode ser 'call'/'whatsapp' (validado defensivamente; um
  // tipo inesperado nunca abre picker, nunca registra nada).
  function handleStartAssisted(leadId, type) {
    if (type !== 'call' && type !== 'whatsapp') return;
    if (!assistedAction || assistedAction.leadId !== leadId) clearAssistedError();
    setAssistedAction({ leadId, type });
  }

  function handleCancelAssisted(leadId) {
    if (!assistedAction || assistedAction.leadId !== leadId) return;
    setAssistedAction(null);
    clearAssistedError();
  }

  // Fase 2D.2.B — mesmo handler para call e whatsapp: `actionKey` já
  // vem do chamador (CallResultPicker passa 'call_connected'/
  // 'call_no_answer', WhatsAppResultPicker passa 'whatsapp_sent').
  //
  // Fase 2D.2.C.1 — guard extra de coerência: mesmo que algum chamador
  // futuro passe um actionKey incompatível com o tipo congelado (ex.
  // 'whatsapp_sent' numa ação iniciada como 'call'), nunca chega a
  // criar um fato comercial incompatível — só ignora, sem registrar.
  async function handleAssistedResult(leadId, actionKey) {
    if (!assistedAction || assistedAction.leadId !== leadId) return;
    const allowed = ASSISTED_RESULT_ACTIONS[assistedAction.type];
    if (!allowed || !allowed.includes(actionKey)) return;
    try {
      const inserted = await registerAssistedAction(leadId, actionKey);
      if (!inserted) return; // guard de duplo clique (register já em andamento)
      setAssistedAction(null);
      // interactions central já atualiza dentro de registerCommercialInteraction
      // (useAppState.js) — a fila recalcula sozinha a partir da prop, sem
      // atualização manual paralela aqui.
    } catch (e) {
      // erro já populado em assistedError pelo hook; picker permanece
      // aberto (continua montado porque o lead, por enquanto, ainda está em due).
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
                  assistedAction={assistedAction}
                  assistedRegistering={assistedRegistering}
                  assistedError={assistedError}
                  onStartAssisted={handleStartAssisted}
                  onAssistedResult={handleAssistedResult}
                  onCancelAssisted={handleCancelAssisted}
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
