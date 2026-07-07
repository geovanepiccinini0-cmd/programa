import { useEffect, useState } from 'react';
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
import { useAppState } from './hooks/useAppState.js';
import { useAuth } from './hooks/useAuth.js';
import { isSupabaseConfigured } from './lib/supabaseClient.js';
import { STAGES } from './constants.js';
import { downloadJSON, todayStr } from './utils.js';

function CrmApp({ userId, isAdmin, onSignOut }) {
  const {
    leads, tasks, templates, loading, error,
    saveLead, deleteLead, moveStage,
    addTask, toggleTask, deleteTask,
    addRotina, toggleRotinaAtiva, deleteRotina,
    importBackup,
  } = useAppState(userId);

  const [activeTab, setActiveTab] = useState('hoje');
  const [filterProduto, setFilterProduto] = useState('Todos');
  const [filterStale, setFilterStale] = useState(false);
  const [leadModalOpen, setLeadModalOpen] = useState(false);
  const [editingLead, setEditingLead] = useState(null);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [, forceTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 60000);
    return () => clearInterval(id);
  }, []);

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

  function handleDeleteRotina(id) {
    if (confirm('Excluir esta rotina? As tarefas já geradas continuam na lista, mas ela para de gerar novas.')) {
      deleteRotina(id);
    }
  }

  function handleExportBackup() {
    const backup = { leads, tasks, templates, exportadoEm: new Date().toISOString() };
    downloadJSON(backup, `backup-crm-piccinini-${todayStr()}.json`);
  }

  async function handleImportBackup(file) {
    try {
      const text = await file.text();
      const backup = JSON.parse(text);
      if (!Array.isArray(backup.leads) || !Array.isArray(backup.tasks)) throw new Error('Arquivo de backup inválido.');
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

      {activeTab !== 'metricas' && <StatsBar leads={leads} tasks={tasks} />}

      {activeTab === 'metricas' && isAdmin && <MetricasView userId={userId} />}

      {activeTab === 'hoje' && (
        <HojeView
          leads={leads}
          tasks={tasks}
          onAddTask={addTask}
          onToggleTask={toggleTask}
          onDeleteTask={deleteTask}
        />
      )}

      {activeTab === 'funil' && (
        <FunilView
          leads={leads}
          filterProduto={filterProduto}
          setFilterProduto={setFilterProduto}
          filterStale={filterStale}
          setFilterStale={setFilterStale}
          onEdit={handleEditLead}
          onDelete={handleDeleteLead}
          onMoveStage={handleMoveStage}
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
