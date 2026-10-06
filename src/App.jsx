import { useEffect, useMemo, useState } from 'react';
import Header from './components/Header.jsx';
import StatsBar from './components/StatsBar.jsx';
import HojeView from './components/HojeView.jsx';
import FunilView from './components/FunilView.jsx';
import RotinaView from './components/RotinaView.jsx';
import LeadModal from './components/LeadModal.jsx';
import ExportModal from './components/ExportModal.jsx';
import Login from './components/Login.jsx';
import SetupNeeded from './components/SetupNeeded.jsx';
import MetricasView from './components/MetricasView.jsx';
import AppointmentAlertBanner from './components/AppointmentAlertBanner.jsx';
import { useAppState } from './hooks/useAppState.js';
import { useAuth } from './hooks/useAuth.js';
import { useAppointmentAlerts } from './hooks/useAppointmentAlerts.js';
import { isSupabaseConfigured } from './lib/supabaseClient.js';
import { interactionsApi } from './lib/db.js';
import { STAGES } from './constants.js';
import { downloadJSON, isValidBackup, todayStr } from './utils.js';

const BACKUP_VERSION = 2;

function CrmApp({ userId, isAdmin, onSignOut }) {
  const {
    leads, tasks, templates, loading, error,
    interactions, interactionsLoading, interactionsError, refetchInteractions,
    saveLead, deleteLead, moveStage, setLeadStage,
    addTask, toggleTask, deleteTask, completeTaskWithResult,
    addRotina, toggleRotinaAtiva, deleteRotina,
    importBackup,
    addInteractionNote,
    registerCommercialInteraction,
  } = useAppState(userId);

  const [activeTab, setActiveTab] = useState('hoje');
  const [filterProduto, setFilterProduto] = useState('Todos');
  const [filterStale, setFilterStale] = useState(false);
  const [sortOrder, setSortOrder] = useState('padrao');
  const [searchQuery, setSearchQuery] = useState('');
  const [leadModalOpen, setLeadModalOpen] = useState(false);
  const [editingLead, setEditingLead] = useState(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const appointmentAlerts = useAppointmentAlerts(tasks, leads);

  // Fase 2C.2B — heartbeat de 60s existente (antes só `forceTick`, um
  // contador descartado cujo único efeito era forçar um re-render
  // periódico). Agora guarda um timestamp e devolve, via useMemo, um
  // `now` com IDENTIDADE ESTÁVEL entre renders — só muda quando o
  // heartbeat de fato dispara, nunca a cada re-render por outro motivo
  // (abrir/fechar modal, trocar de aba etc.), o que evitaria invalidar
  // sem necessidade o useMemo de FollowUpQueue. Nenhum timer novo:
  // mesmo único setInterval de sempre. useAppointmentAlerts mantém seu
  // próprio intervalo de 30s, intocado.
  const [clockTick, setClockTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClockTick(Date.now()), 60000);
    return () => clearInterval(id);
  }, []);
  const now = useMemo(() => new Date(clockTick), [clockTick]);

  function handleNewLead() {
    setEditingLead(null);
    setLeadModalOpen(true);
  }

  function handleEditLead(lead) {
    setEditingLead(lead);
    setLeadModalOpen(true);
  }

  function handleSaveLead(id, data) {
    saveLead(id, data);
    setLeadModalOpen(false);
  }

  function handleDeleteLead(id) {
    if (confirm('Excluir este lead? Essa ação não pode ser desfeita.')) {
      deleteLead(id);
    }
  }

  function handleMoveStage(id, dir) {
    moveStage(id, dir, STAGES);
  }

  function handleDropStage(id, etapa) {
    setLeadStage(id, etapa);
  }

  function handleDeleteRotina(id) {
    if (confirm('Excluir esta rotina? As tarefas já geradas continuam na lista, mas ela para de gerar novas.')) {
      deleteRotina(id);
    }
  }

  async function handleExportBackup() {
    let interactions = [];
    try {
      interactions = await interactionsApi.fetchAllForUser(userId);
    } catch (e) {
      console.warn('Não foi possível incluir o histórico no backup (migration 007 já foi rodada no Supabase?):', e);
    }
    const backup = {
      backupVersion: BACKUP_VERSION, leads, tasks, templates, interactions, exportadoEm: new Date().toISOString(),
    };
    downloadJSON(backup, `backup-crm-piccinini-${todayStr()}.json`);
  }

  async function handleImportBackup(file) {
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      if (!isValidBackup(backup)) throw new Error('Arquivo de backup inválido.');
      const substituir = confirm('Importar este backup vai SUBSTITUIR todos os leads, tarefas e rotinas atuais. Deseja continuar?');
      if (!substituir) return;
      await importBackup(backup);
      alert('Backup importado com sucesso.');
    } catch (err) {
      alert('Não foi possível importar: ' + err.message);
    }
  }

  if (loading) {
    return <div className="app"><div className="empty-state">Carregando seus dados...</div></div>;
  }

  if (error) {
    return (
      <div className="app">
        <div className="empty-state" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
          Não foi possível carregar os dados: {error.message}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <Header
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onNewLead={handleNewLead}
        onOpenExport={() => setExportModalOpen(true)}
        onExportBackup={handleExportBackup}
        onImportBackup={handleImportBackup}
        onSignOut={onSignOut}
        isAdmin={isAdmin}
      />

      <AppointmentAlertBanner
        upcoming={appointmentAlerts.upcoming}
        permission={appointmentAlerts.permission}
        onRequestPermission={appointmentAlerts.requestPermission}
        onDismiss={appointmentAlerts.dismiss}
        leads={leads}
      />

      {activeTab !== 'metricas' && <StatsBar leads={leads} tasks={tasks} />}

      {activeTab === 'metricas' && isAdmin && <MetricasView userId={userId} />}

      {activeTab === 'hoje' && (
        <HojeView
          leads={leads}
          tasks={tasks}
          onAddTask={addTask}
          onToggleTask={toggleTask}
          onDeleteTask={deleteTask}
          onCompleteWithResult={completeTaskWithResult}
          interactions={interactions}
          interactionsLoading={interactionsLoading}
          interactionsError={interactionsError}
          now={now}
          onEditLead={handleEditLead}
          onRetryInteractions={refetchInteractions}
          onRegisterCommercialInteraction={registerCommercialInteraction}
        />
      )}

      {activeTab === 'funil' && (
        <FunilView
          leads={leads}
          filterProduto={filterProduto}
          setFilterProduto={setFilterProduto}
          filterStale={filterStale}
          setFilterStale={setFilterStale}
          sortOrder={sortOrder}
          setSortOrder={setSortOrder}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          onEdit={handleEditLead}
          onDelete={handleDeleteLead}
          onMoveStage={handleMoveStage}
          onDropStage={handleDropStage}
        />
      )}

      {activeTab === 'rotina' && (
        <RotinaView
          templates={templates}
          onAddRotina={addRotina}
          onToggleAtiva={toggleRotinaAtiva}
          onDeleteRotina={handleDeleteRotina}
        />
      )}

      {leadModalOpen && (
        <LeadModal
          lead={editingLead}
          tasks={tasks}
          onClose={() => setLeadModalOpen(false)}
          onSave={handleSaveLead}
          onAddInteractionNote={addInteractionNote}
          onRegisterCommercialInteraction={registerCommercialInteraction}
        />
      )}

      {exportModalOpen && (
        <ExportModal leads={leads} onClose={() => setExportModalOpen(false)} />
      )}
    </div>
  );
}

export default function App() {
  const { session, loading, userId, isAdmin, signIn, signOut } = useAuth();

  if (!isSupabaseConfigured) {
    return <SetupNeeded />;
  }

  if (loading) {
    return <div className="app"><div className="empty-state">Carregando...</div></div>;
  }

  if (!session) {
    return <Login onSignIn={signIn} />;
  }

  return <CrmApp userId={userId} isAdmin={isAdmin} onSignOut={signOut} />;
}
