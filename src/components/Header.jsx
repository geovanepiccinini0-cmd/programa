import { useRef } from 'react';
import { BUILD_VERSION } from '../constants.js';
import Icon from './Icon.jsx';

const TABS = [
  { key: 'hoje', label: 'Hoje', icon: 'calendar' },
  { key: 'funil', label: 'Funil', icon: 'columns' },
  { key: 'rotina', label: 'Rotina', icon: 'repeat' },
  { key: 'conversas', label: 'Conversas', icon: 'chat' },
];

export default function Header({ activeTab, onTabChange, onNewLead, onOpenExport, onExportBackup, onImportBackup, onSignOut, isAdmin }) {
  const fileInputRef = useRef(null);
  const tabs = isAdmin ? [...TABS, { key: 'metricas', label: 'Métricas', icon: 'chart' }] : TABS;

  function handleFileChange(e) {
    const file = e.target.files[0];
    if (file) onImportBackup(file);
    e.target.value = '';
  }

  return (
    <>
    <aside className="crm-sidebar" aria-label="Navegação principal">
      <div className="brand">
        <img src="/brand/geovane-piccinini.webp" width="520" height="144" alt="Geovane Piccinini — Corretor especialista" />
      </div>
      <div className="sidebar-label">Espaço comercial</div>
      <nav className="tabs" aria-label="Áreas do CRM">
        {tabs.map((t) => (
          <button
            key={t.key}
            className={`tab-btn ${activeTab === t.key ? 'active' : ''}`}
            type="button"
            aria-current={activeTab === t.key ? 'page' : undefined}
            onClick={() => onTabChange(t.key)}
          >
            <Icon name={t.icon} />{t.label}
          </button>
        ))}
      </nav>
      <div className="sidebar-footer"><strong>Painel Piccinini</strong><span>Cartas contempladas &amp; patrimônio</span><small>{BUILD_VERSION}</small><button className="btn-ghost signout" type="button" onClick={onSignOut}><Icon name="logout" />Sair da conta</button></div>
    </aside>
    <header className="crm-toolbar">
      <div className="breadcrumb">Seu espaço <span>/</span><strong>{tabs.find((t) => t.key === activeTab)?.label}</strong></div>
      <div className="toolbar-actions">
        <details className="tools-menu"><summary><Icon name="tools" />Ferramentas</summary><div className="tools-popover">
        <button className="btn-ghost" type="button" onClick={onOpenExport}>Exportar planilha de leads</button>
        <button className="btn-ghost" type="button" onClick={onExportBackup}>Baixar backup</button>
        <button className="btn-ghost" type="button" onClick={() => fileInputRef.current?.click()}>Importar backup</button>
        </div></details>
        <input ref={fileInputRef} type="file" accept=".json" style={{ display: 'none' }} onChange={handleFileChange} />
        <button className="btn-primary" type="button" onClick={onNewLead}><Icon name="plus" />Novo lead</button>
      </div>
    </header>
    </>
  );
}
