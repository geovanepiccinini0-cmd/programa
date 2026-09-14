import { PROD_COLOR } from '../constants.js';

export default function TaskLeadBadges({ lead }) {
  if (!lead) return null;
  return (
    <>
      <span className="badge" style={{ background: PROD_COLOR[lead.produto] || 'var(--surface-2)', color: '#0a1628' }}>
        {lead.produto}
      </span>
      <span className="badge" style={{ background: 'var(--surface-2)', color: 'var(--text)' }}>
        {lead.etapa}
      </span>
      {lead.telefone && (
        <a
          href={`tel:${lead.telefone.replace(/\D/g, '')}`}
          className="badge"
          style={{ background: 'var(--surface-2)', color: 'var(--text)', textDecoration: 'none' }}
          onClick={(e) => e.stopPropagation()}
        >
          📞 {lead.telefone}
        </a>
      )}
    </>
  );
}
