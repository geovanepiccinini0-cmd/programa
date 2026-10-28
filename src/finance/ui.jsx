import { money } from './model.js';
export function Field({ label, children, ...props }) { return <label className="fin-field"><span>{label}</span>{children || <input {...props}/>}</label>; }
export function Amount({ label, value, onChange, ...props }) { return <Field label={label}><input type="number" min="0" step="0.01" value={value} onChange={e => onChange(e.target.value)} {...props}/></Field>; }
export function Panel({ title, note, children, actions, className='' }) { return <section className={`fin-panel ${className}`}><div className="fin-panel-head"><div><h2>{title}</h2>{note && <p>{note}</p>}</div>{actions}</div>{children}</section>; }
export function Kpis({ items }) { return <div className="fin-kpis">{items.map(([label,value,note])=><div className="fin-kpi" key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}</div>; }
export function Empty({ children='Nenhum registro nesta seleção.' }) { return <div className="fin-empty">{children}</div>; }
export function Table({ headers, children, foot }) { return <div className="fin-table-scroll"><table className="fin-table"><thead><tr>{headers.map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{children}</tbody>{foot && <tfoot>{foot}</tfoot>}</table></div>; }
export function Status({ value }) { return <span className={`fin-status ${value}`}>{{draft:'Pendente de dados',confirmed:'Confirmada',cancelled:'Cancelada'}[value] || value}</span>; }
export function CashValue({ value }) { return <span className="fin-currency">{money(value)}</span>; }
