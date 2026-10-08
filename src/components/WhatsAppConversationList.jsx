import { formatRelativeTime } from '../utils.js';

// Fase 3.5.1 — lista de conversas (lead + prévia da última mensagem),
// ordenada pela mensagem mais recente (já feito por quem chama, via
// sortConversationsByRecency em src/lib/whatsappMessages.js). Puramente
// apresentacional — nenhum fetch aqui.
export default function WhatsAppConversationList({
  conversations, selectedLeadId, onSelect, loading, error, onRetry, hasMore, onLoadMore,
}) {
  if (loading) {
    return <div className="empty-state">Carregando conversas...</div>;
  }
  if (error) {
    return (
      <div className="empty-state" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
        Não foi possível carregar as conversas.
        <div style={{ marginTop: 8 }}>
          <button type="button" className="btn-ghost" onClick={onRetry}>Tentar novamente</button>
        </div>
      </div>
    );
  }
  if (conversations.length === 0) {
    return <div className="empty-state">Nenhuma mensagem de WhatsApp recebida ainda.</div>;
  }

  return (
    <div className="wa-conversation-list">
      {conversations.map((c) => (
        <button
          type="button"
          key={c.leadId}
          className={`wa-conversation-item${c.leadId === selectedLeadId ? ' active' : ''}`}
          onClick={() => onSelect(c.leadId)}
        >
          <div className="wa-conversation-top">
            <span className="wa-conversation-nome">{c.leadNome}</span>
            <span className="wa-conversation-time">{formatRelativeTime(c.lastMessageAt)}</span>
          </div>
          <div className="wa-conversation-preview">{c.preview}</div>
        </button>
      ))}
      {hasMore && (
        <button type="button" className="btn-ghost" style={{ width: '100%', marginTop: 8 }} onClick={onLoadMore}>
          Carregar conversas mais antigas
        </button>
      )}
    </div>
  );
}
