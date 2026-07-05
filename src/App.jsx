import { useEffect, useState } from 'react';
import Header from './components/Header.jsx';
import StatsBar from './components/StatsBar.jsx';
import HojeView from './components/HojeView.jsx';
import FunilView from './components/FunilView.jsx';
import RotinaView from './components/RotinaView.jsx';
import LeadModal from './components/LeadModal.jsx';
import ExportModal from './components/ExportModal.jsx';
import { useAppState } from './hooks/useAppState.js';
import { STAGES } from './constants.js';
import { downloadJSON, todayStr } from './utils.js';

export default function App() {
  const {
    leads, tasks, templates,
    saveLead, deleteLead, moveStage,
    addTask, toggleTask, deleteTask,
    addRotina, toggleRotinaAtiva, deleteRotina,
    importBackup,
  } = useAppState();

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
      importBackup(backup);
      alert('Backup importado com sucesso.');
    } catch (err) {
      alert('Não foi possível importar: ' + err.message);
    }
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
      />

      <StatsBar leads={leads} tasks={tasks} />

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
