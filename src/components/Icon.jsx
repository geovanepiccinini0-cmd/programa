const shapes = {
  calendar: <><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4m8-4v4M4 11h16"/></>,
  columns: <><rect x="3" y="5" width="18" height="15" rx="2"/><path d="M9 5v15m6-15v15"/></>,
  repeat: <><path d="M4 8h15l-4-4M20 16H5l4 4M4 8v5m16-5v8"/></>,
  chat: <path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z"/>,
  chart: <><path d="M4 3v17h17M8 15l4-5 4 2 5-7"/></>,
  plus: <path d="M12 5v14M5 12h14"/>,
  file: <><path d="M14 3H6v18h12V7l-4-4Zm0 0v5h5M9 17v-3m3 3v-6m3 6v-4"/></>,
  tools: <><path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="10" cy="18" r="2"/></>,
  logout: <><path d="M9 4H4v16h5m5-13 5 5-5 5M9 12h10"/></>,
};

export default function Icon({ name, ...props }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>{shapes[name] || shapes.file}</svg>;
}
