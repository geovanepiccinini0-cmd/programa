import { formatRelativeTime } from '../utils.js';
import { STAGES, TAGS_LEAD } from '../constants.js';
import { hasActiveConversationFilters } from '../lib/whatsappConversationFilters.js';
import { unreadCountForLead } from '../lib/whatsappUnreadTracking.js';

// Fase 3.5.1 (lista) + 3.6.0 (busca/filtros) — lista de conversas
// (lead + prévia da última mensagem), ordenada pela mensagem mais
// recente (já feito por quem chama, via sortConversationsByRecency +
// filterConversations em src/lib/). Puramente apresentacional —
// nenhum fetch aqui; os filtros operam só sobre o que já foi
// carregado (ver whatsappConversationFilters.js).
export default function WhatsAppConversationList({
  conversations, selectedLeadId, onSelect, loading, error, onRetry, hasMore, onLoadMore,
  filters, onFiltersChange, onClearFilters, totalCount, unreadCounts,
}) {
  const filtersActive = hasActiveConversationFilters(filters);

  function toggleTag(tag) {
    const current = filters.tags || [];
    const next = current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag];
    onFiltersChange({ ...filters, tags: next });
  }

  const filterBar = (
    <div className="wa-filter-bar">
      <input
        type="text"
        className="wa-filter-search"
        placeholder="Buscar por nome..."
        value={filters.searchText}
        onChange={(e) => onFiltersChange({ ...filters, searchText: e.target.value })}
      />
      <select
        className="wa-filter-etapa"
        value={filters.etapa || ''}
        onChange={(e) => onFiltersChange({ ...filters, etapa: e.target.value || null })}
      >
        <option value="">Todas as etapas</option>
        {STAGES.map((stage) => (
          <option key={stage} value={stage}>{stage}</option>
        ))}
      </select>
      <div className="wa-filter-tags">
        {TAGS_LEAD.map((tag) => (
          <button
            type="button"
            key={tag}
            className={`chip${(filters.tags || []).includes(tag) ? ' active' : ''}`}
            onClick={() => toggleTag(tag)}
          >
            {tag}
          </button>
        ))}
      </div>
      {filtersActive && (
        <button type="button" className="btn-ghost wa-filter-clear" onClick={onClearFilters}>
          Limpar filtros
        </button>
      )}
    </div>
  );

  if (loading) {
    return (
      <div className="wa-conversation-list-pane-inner">
        {filterBar}
        <div className="empty-state">Carregando conversas...</div>
      </div>
    );
  }
  if (error) {
    return (
      <div className="wa-conversation-list-pane-inner">
        {filterBar}
        <div className="empty-state" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
          Não foi possível carregar as conversas.
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn-ghost" onClick={onRetry}>Tentar novamente</button>
          </div>
        </div>
      </div>
    );
  }
  if (totalCount === 0) {
    return (
      <div className="wa-conversation-list-pane-inner">
        {filterBar}
        <div className="empty-state">Nenhuma mensagem de WhatsApp recebida ainda.</div>
      </div>
    );
  }

  return (
    <div className="wa-conversation-list-pane-inner">
      {filterBar}

      {conversations.length === 0 ? (
        <div className="empty-state">
          Nenhuma conversa corresponde aos filtros aplicados.
          <div style={{ marginTop: 8 }}>
            <button type="button" className="btn-ghost" onClick={onClearFilters}>Limpar filtros</button>
          </div>
        </div>
      ) : (
        <div className="wa-conversation-list">
          {conversations.map((c) => {
            // Fase 3.6.3 — contador de não lidas (leitura humana,
            // nunca status de entrega da Meta). Fonte: unreadCounts
            // (useWhatsAppInbox), derivado do servidor.
            const unread = unreadCountForLead(unreadCounts, c.leadId);
            return (
              <button
                type="button"
                key={c.leadId}
                className={`wa-conversation-item${c.leadId === selectedLeadId ? ' active' : ''}${unread > 0 ? ' wa-conversation-unread' : ''}`}
                onClick={() => onSelect(c.leadId)}
              >
                <div className="wa-conversation-top">
                  <span className="wa-conversation-nome">{c.leadNome}</span>
                  <span className="wa-conversation-time">{formatRelativeTime(c.lastMessageAt)}</span>
                </div>
                <div className="wa-conversation-preview-row">
                  <span className="wa-conversation-preview">{c.preview}</span>
                  {unread > 0 && (
                    <span className="wa-conversation-unread-badge" aria-label={`${unread} mensagens não lidas`}>
                      {unread > 99 ? '99+' : unread}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
          {hasMore && (
            <button type="button" className="btn-ghost" style={{ width: '100%', marginTop: 8 }} onClick={onLoadMore}>
              Carregar conversas mais antigas
            </button>
          )}
          {/* Fase 3.6.0 — requisito explícito: a filtragem nunca sugere
              abranger conversas ainda não carregadas pela paginação.
              Com filtro ativo e mais histórico disponível, o usuário
              precisa saber que o resultado é limitado ao que já foi
              buscado (carregar mais antigas, acima, continua sendo a
              única forma de ampliar a janela). */}
          {filtersActive && hasMore && (
            <div className="wa-filter-scope-note">
              Resultados limitados às conversas já carregadas — carregue mais antigas para ampliar a busca.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
