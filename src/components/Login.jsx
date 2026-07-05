import { useState } from 'react';

export default function Login({ onSignIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await onSignIn(email, password);
    } catch (err) {
      setError(err.message === 'Invalid login credentials' ? 'E-mail ou senha inválidos.' : err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <form onSubmit={handleSubmit} className="modal" style={{ maxWidth: 360, width: '100%' }}>
        <div className="brand" style={{ marginBottom: 18 }}>
          <div className="brand-mark">CI</div>
          <div className="brand-text">
            <h1>Painel Piccinini</h1>
            <span>Entre para acessar seu CRM</span>
          </div>
        </div>
        {error && (
          <div style={{ background: '#2a1418', border: '1px solid var(--red)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>
            {error}
          </div>
        )}
        <div className="field">
          <label htmlFor="login-email">E-mail</label>
          <input id="login-email" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="login-password">Senha</label>
          <input id="login-password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <button type="submit" className="btn-primary" style={{ width: '100%', marginTop: 8 }} disabled={submitting}>
          {submitting ? 'Entrando...' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
