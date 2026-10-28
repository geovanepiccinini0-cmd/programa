import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';

// Netlify Deploy Previews never mount the authenticated CRM or its Supabase
// client. Only fictional browser-local data is available in this build.
const preview = __FINANCE_PREVIEW__ || (import.meta.env.DEV && new URLSearchParams(window.location.search).has('finance-preview'));
const App = React.lazy(() => preview ? import('./finance/FinancePreview.jsx') : import('./App.jsx'));

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <React.Suspense fallback={<div className="empty-state">Carregando CRM...</div>}><App /></React.Suspense>
  </React.StrictMode>,
);
