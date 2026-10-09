import { useState } from 'react';
import { messageDisplayText } from '../lib/whatsappMessages.js';
import { SEND_ERROR_MESSAGES } from '../lib/whatsappSend.js';

function fmtMessageTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// Fase 3.5.2.4 — ícone/rótulo de status de uma bolha OUTBOUND. Nunca
// mostra "entregue"/"lido" a partir do aceite da Meta — esses dois só
// chegam pela própria coluna `status` da mensagem (atualizada via
// Realtime pelo webhook de status, nunca por este componente).
function outboundStatusBadge(message) {
  switch (message.status) {
    case 'sending':
    case 'queued':
      return { icon: '🕐', label: 'Enviando...' };
    case 'sent':
      return { icon: '✓', label: 'Enviado' };
    case 'delivered':
      return { icon: '✓✓', label: 'Entregue' };
    case 'read':
      return { icon: '✓✓', label: 'Lido', read: true };
    case 'uncertain':
      return { icon: '⏳', label: 'Resultado incerto' };
    case 'failed':
      return { icon: '⚠', label: 'Falhou', failed: true };
    default:
      return null;
  }
}

function ComposerNotice({ notice }) {
  if (!notice) return null;
  if (notice.kind === 'window_closed') {
    const expires = notice.windowExpiresAt ? new Date(notice.windowExpiresAt) : null;
    return (
      <div className="wa-composer-notice" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
        A janela de 24 horas para responder esta conversa está encerrada
        {expires ? ` (encerrou em ${fmtMessageTime(expires.toISOString())}).` : '.'} Aguarde uma nova mensagem do contato.
      </div>
    );
  }
  const text = SEND_ERROR_MESSAGES[notice.kind] || 'Não foi possível concluir o envio.';
  const soft = notice.kind === 'uncertain' || notice.kind === 'network_uncertain';
  return (
    <div
      className="wa-composer-notice"
      style={{ borderColor: soft ? 'var(--text-dim)' : 'var(--red)', color: soft ? 'var(--text-dim)' : 'var(--red)' }}
    >
      {text}
    </div>
  );
}

// Fase 3.5.2.4 — histórico cronológico de UMA conversa, agora com
// envio de mensagens (composer no final da thread). Conteúdo textual
// continua sempre renderizado como {texto} dentro de JSX — o React
// escapa automaticamente qualquer HTML embutido (nunca interpretado
// como marcação); este componente NUNCA usa dangerouslySetInnerHTML,
// nem para mensagens inbound nem para o conteúdo digitado aqui.
export default function WhatsAppConversationThread({
  lead, messages, loading, error, onRetry, hasMoreOlder, loadingOlder, onLoadOlder, onOpenLead, onBack,
  onSend, sending, composerNotice, sendGate,
}) {
  const [draft, setDraft] = useState('');

  if (!lead) {
    return <div className="empty-state">Selecione uma conversa para ver o histórico.</div>;
  }

  const canType = sendGate ? sendGate.canSend : true;
  const trimmedDraft = draft.trim();
  const canSubmit = canType && !sending && trimmedDraft.length > 0;

  function handleSubmit(e) {
    e.preventDefault();
    if (!canSubmit) return;
    onSend(draft);
    setDraft('');
  }

  function handleKeyDown(e) {
    // Enter envia, Shift+Enter quebra linha — mesmo comportamento do
    // WhatsApp Web (requisito explícito de UX desta fase).
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  return (
    <div className="wa-thread">
      <div className="wa-thread-header">
        <button type="button" className="btn-ghost wa-thread-back" onClick={onBack} aria-label="Voltar para a lista">←</button>
        <div className="wa-thread-header-info">
          <div className="wa-thread-nome">{lead.nome}</div>
        </div>
        <button type="button" className="btn-ghost" onClick={() => onOpenLead(lead)}>Ver lead</button>
      </div>

      <div className="wa-thread-messages">
        {hasMoreOlder && (
          <button type="button" className="btn-ghost" style={{ width: '100%', marginBottom: 8 }} disabled={loadingOlder} onClick={onLoadOlder}>
            {loadingOlder ? 'Carregando...' : 'Carregar mensagens anteriores'}
          </button>
        )}

        {loading && <div className="empty-state">Carregando histórico...</div>}

        {error && (
          <div className="empty-state" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
            Não foi possível carregar o histórico.
            <div style={{ marginTop: 8 }}>
              <button type="button" className="btn-ghost" onClick={onRetry}>Tentar novamente</button>
            </div>
          </div>
        )}

        {!loading && !error && messages.length === 0 && (
          <div className="empty-state">Nenhuma mensagem nesta conversa ainda.</div>
        )}

        {!loading && !error && messages.map((m) => {
          const badge = m.direction === 'outbound' ? outboundStatusBadge(m) : null;
          return (
            <div key={m.id} className={`wa-message-bubble ${m.direction === 'outbound' ? 'outbound' : 'inbound'}`}>
              <div className="wa-message-content">{messageDisplayText(m)}</div>
              <div className={`wa-message-time${badge?.failed ? ' wa-message-status-failed' : ''}`}>
                {fmtMessageTime(m.occurredAt)}
                {badge && (
                  <span className={`wa-message-status${badge.read ? ' wa-message-status-read' : ''}`} title={badge.label}>
                    {' '}{badge.icon}
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <ComposerNotice notice={composerNotice} />

      {!canType && !composerNotice && sendGate?.reason === 'no_identity' && (
        <div className="wa-composer-notice" style={{ borderColor: 'var(--text-dim)', color: 'var(--text-dim)' }}>
          Esta conversa ainda não recebeu nenhuma mensagem — envio indisponível até que o contato escreva primeiro.
        </div>
      )}

      <form className="wa-thread-composer" onSubmit={handleSubmit}>
        <textarea
          className="wa-composer-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={canType ? 'Digite uma mensagem...' : 'Envio indisponível para esta conversa'}
          disabled={!canType || sending}
          rows={1}
          maxLength={4096}
        />
        <button type="submit" className="wa-composer-send" disabled={!canSubmit}>
          {sending ? '...' : 'Enviar'}
        </button>
      </form>
    </div>
  );
}
