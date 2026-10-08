import { messageDisplayText } from '../lib/whatsappMessages.js';

function fmtMessageTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

// Fase 3.5.1 — histórico cronológico de UMA conversa (SOMENTE LEITURA:
// sem campo de digitação, sem botão de enviar — ver banner fixo).
// Conteúdo textual é renderizado como {texto} dentro de JSX — o React
// escapa automaticamente qualquer HTML embutido (nunca interpretado
// como marcação); este componente NUNCA usa dangerouslySetInnerHTML.
export default function WhatsAppConversationThread({
  lead, messages, loading, error, onRetry, hasMoreOlder, loadingOlder, onLoadOlder, onOpenLead, onBack,
}) {
  if (!lead) {
    return <div className="empty-state">Selecione uma conversa para ver o histórico.</div>;
  }

  return (
    <div className="wa-thread">
      <div className="wa-thread-header">
        <button type="button" className="btn-ghost wa-thread-back" onClick={onBack} aria-label="Voltar para a lista">←</button>
        <div className="wa-thread-header-info">
          <div className="wa-thread-nome">{lead.nome}</div>
          <div className="wa-readonly-badge" title="Esta visualização é somente leitura — envio de mensagens ainda não está disponível.">
            👁 Somente leitura
          </div>
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

        {!loading && !error && messages.map((m) => (
          <div key={m.id} className={`wa-message-bubble ${m.direction === 'outbound' ? 'outbound' : 'inbound'}`}>
            <div className="wa-message-content">{messageDisplayText(m)}</div>
            <div className="wa-message-time">{fmtMessageTime(m.occurredAt)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
