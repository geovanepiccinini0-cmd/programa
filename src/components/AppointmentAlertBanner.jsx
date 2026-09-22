export default function AppointmentAlertBanner({ upcoming, permission, onRequestPermission, onDismiss, leads }) {
  if (upcoming.length === 0) return null;

  return (
    <div style={{ marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {permission === 'default' && (
        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', fontSize: 12.5, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span>Ative as notificações do navegador para ser avisado mesmo em outra aba.</span>
          <button type="button" className="icon-btn" style={{ flex: 'none' }} onClick={onRequestPermission}>Ativar notificações</button>
        </div>
      )}
      {upcoming.map(({ task, minutesLeft }) => {
        const lead = task.leadId ? leads.find((l) => l.id === task.leadId) : null;
        return (
          <div
            key={task.id}
            style={{
              background: '#2a1f10',
              border: '1px solid var(--orange)',
              borderRadius: 8,
              padding: '10px 14px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ fontSize: 13 }}>
              <strong style={{ color: 'var(--orange)' }}>
                ⏰ {minutesLeft === 0 ? 'Agora' : `Em ${minutesLeft} min`}
              </strong>
              {' · '}
              {task.titulo}
              {lead && lead.telefone && (
                <>
                  {' · '}
                  <a href={`tel:${lead.telefone.replace(/\D/g, '')}`} style={{ color: 'var(--text)' }}>
                    📞 {lead.telefone}
                  </a>
                </>
              )}
            </div>
            <button type="button" className="icon-btn" style={{ flex: 'none' }} onClick={() => onDismiss(task.id)}>Dispensar</button>
          </div>
        );
      })}
    </div>
  );
}
