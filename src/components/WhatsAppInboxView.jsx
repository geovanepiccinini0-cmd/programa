import { useState } from 'react';
import { useWhatsAppInbox } from '../hooks/useWhatsAppInbox.js';
import { leadsApi } from '../lib/db.js';
import { todayStr } from '../utils.js';
import WhatsAppConversationList from './WhatsAppConversationList.jsx';
import WhatsAppConversationThread from './WhatsAppConversationThread.jsx';
import LeadModal from './LeadModal.jsx';

// Fase 3.5.1 (leitura) + 3.5.2.4 (envio) — Caixa de entrada WhatsApp
// (página "Conversas"). Lê public.whatsapp_messages (migrations
// 018/019) e agora também envia, exclusivamente através da Edge
// Function `whatsapp-send` (useWhatsAppInbox.sendMessage ->
// src/lib/whatsappSend.js) — nenhuma escrita direta em
// whatsapp_messages pelo navegador (RLS continua só SELECT para
// dono/admin). Self-contido (mesmo padrão de MetricasView.jsx): busca
// os próprios dados via useWhatsAppInbox, nunca entrelaçado com
// useAppState.js.
//
// "Ver lead" reabre exatamente o mesmo LeadModal/leadsApi já usados em
// todo o resto do CRM (FunilView, HojeView, MetricasView) — mesma RLS,
// mesmo fluxo de salvar, nenhuma rota/permissão nova criada.
export default function WhatsAppInboxView({ userId }) {
  const {
    conversations, conversationsLoading, conversationsError, refetchConversations,
    hasMoreConversationHistory, loadMoreConversationHistory,
    selectedLeadId, selectedLead, selectConversation,
    threadMessages, threadLoading, threadError, retryThread,
    hasMoreOlderMessages, loadingOlderMessages, loadOlderMessages,
    sendMessage, composerSending, composerNotice, sendGate,
    conversationFilters, setConversationFilters, clearConversationFilters, totalConversationsCount,
    conversationState, setConversationStatus,
    unreadCounts,
  } = useWhatsAppInbox(userId);

  const [editingLead, setEditingLead] = useState(null);
  const [leadModalOpen, setLeadModalOpen] = useState(false);

  function handleOpenLead(lead) {
    setEditingLead(lead);
    setLeadModalOpen(true);
  }

  async function handleSaveLead(id, data) {
    await leadsApi.update(id, { ...data, ultimaAtualizacao: todayStr() });
    setLeadModalOpen(false);
  }

  return (
    <section className="view active">
      <div className={`wa-inbox${selectedLeadId ? ' has-selection' : ''}`}>
        <div className="wa-inbox-list-pane">
          <WhatsAppConversationList
            conversations={conversations}
            selectedLeadId={selectedLeadId}
            onSelect={selectConversation}
            loading={conversationsLoading}
            error={conversationsError}
            onRetry={refetchConversations}
            hasMore={hasMoreConversationHistory}
            onLoadMore={loadMoreConversationHistory}
            filters={conversationFilters}
            onFiltersChange={setConversationFilters}
            onClearFilters={clearConversationFilters}
            totalCount={totalConversationsCount}
            unreadCounts={unreadCounts}
          />
        </div>
        <div className="wa-inbox-thread-pane">
          <WhatsAppConversationThread
            lead={selectedLead}
            messages={threadMessages}
            loading={threadLoading}
            error={threadError}
            onRetry={retryThread}
            hasMoreOlder={hasMoreOlderMessages}
            loadingOlder={loadingOlderMessages}
            onLoadOlder={loadOlderMessages}
            onOpenLead={handleOpenLead}
            onBack={() => selectConversation(null)}
            onSend={sendMessage}
            sending={composerSending}
            composerNotice={composerNotice}
            sendGate={sendGate}
            conversationState={conversationState}
            onChangeConversationStatus={setConversationStatus}
          />
        </div>
      </div>

      {leadModalOpen && (
        <LeadModal
          lead={editingLead}
          tasks={[]}
          onClose={() => setLeadModalOpen(false)}
          onSave={handleSaveLead}
        />
      )}
    </section>
  );
}
