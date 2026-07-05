import { useRef } from 'react';
import { BUILD_VERSION } from '../constants.js';

const TABS = [
  { key: 'hoje', label: 'Hoje' },
  { key: 'funil', label: 'Funil' },
  { key: 'rotina', label: 'Rotina' },
];

export default function Header({ activeTab, onTabChange, onNewLead, onOpenExport, onExportBackup, onImportBackup }) {
  const fileInputRef = useRef(null);

  function handleFileChange(e) {
    const file = e.target.files[0];
    if (file) onImportBackup(file);
    e.target.value = '';
  }

  return (
    <header className="top">
      <div className="brand">
        <div className="brand-mark">CI</div>
        <div className="brand-text">
          <h1>Painel Piccinini</h1>
          <span>
            Conseg Invest · Cartas Contempladas &amp; Patrimônio ·{' '}
            <span style={{ opacity: 0.6 }}>{BUILD_VERSION}</span>
          </span>
        </div>
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`tab-btn ${activeTab === t.key ? 'active' : ''}`}
            onClick={() => onTabChange(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn-ghost" title="Exportar leads filtrados para planilha" onClick={onOpenExport}>📊 Planilha</button>
        <button className="btn-ghost" title="Exportar backup em arquivo" onClick={onExportBackup}>⬇ Backup</button>
        <button className="btn-ghost" title="Importar backup de arquivo" onClick={() => fileInputRef.current?.click()}>⬆ Importar</button>
        <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleFileChange} />
        <button className="btn-primary" onClick={onNewLead}>+ Novo Lead</button>
      </div>
    </header>
  );
}
