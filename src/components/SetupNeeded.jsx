export default function SetupNeeded() {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div className="modal" style={{ maxWidth: 480, width: '100%' }}>
        <h2>Backend ainda não configurado</h2>
        <p style={{ fontSize: 13.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
          Este CRM precisa de um projeto <strong>Supabase</strong> para guardar seus dados.
          Siga o passo a passo do arquivo <code>README.md</code> (seção &quot;Criar o backend no Supabase&quot;)
          e crie um arquivo <code>.env</code> na raiz do projeto com:
        </p>
        <pre style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12, fontSize: 12.5, overflowX: 'auto' }}>
{`VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co
VITE_SUPABASE_ANON_KEY=sua-chave-anon-public`}
        </pre>
        <p style={{ fontSize: 13.5, color: 'var(--text-dim)' }}>
          Depois reinicie o servidor (<code>npm run dev</code>) ou redeploy, se estiver hospedado online.
        </p>
      </div>
    </div>
  );
}
