import { useEffect, useRef, useState } from 'react';
import { customerPortfolio } from './customers.js';
import { businessDate, validDate } from './model.js';

export default function BirthdayReminder({ state, leads, onOpenCustomer }) {
  const dialog = useRef(null);
  const [today, setToday] = useState(businessDate);
  const [dismissed, setDismissed] = useState('');
  useEffect(() => {
    const refresh = () => setToday(businessDate());
    const timer = setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);
  const customers = state ? customerPortfolio(state, leads).filter(c =>
    validDate(c.birth) && c.birth.slice(5) === today.slice(5)
  ) : [];
  const visible = customers.length > 0 && dismissed !== today;
  useEffect(() => {
    if (visible && !dialog.current.open) dialog.current.showModal();
    if (!visible && dialog.current.open) dialog.current.close();
  }, [visible]);
  const dismiss = () => { setDismissed(today); dialog.current.close(); };
  return <dialog ref={dialog} className="birthday-reminder" aria-labelledby="birthday-title" onCancel={dismiss}>
    <span className="eyebrow">🎂 Um motivo para se aproximar</span>
    <h2 id="birthday-title">Hoje tem aniversário!</h2>
    <p>Lembre de desejar um feliz aniversário para {customers.length === 1 ? 'este cliente' : 'estes clientes'}.</p>
    <ul>{customers.map(c => {
      const digits = (c.phone || '').replace(/\D/g, '');
      const phone = digits.length === 10 || digits.length === 11 ? '55' + digits : digits;
      const text = `Olá, ${c.name.split(' ')[0]}! Passando para desejar um feliz aniversário, com muita saúde e boas conquistas. Um abraço, Geovane!`;
      return <li key={c.id}><strong>{c.name}</strong><div className="birthday-actions">
        <button onClick={() => { dismiss(); onOpenCustomer(c.id); }}>Abrir cadastro</button>
        {phone.length >= 12 && <a className="btn-primary" href={`https://wa.me/${phone}?text=${encodeURIComponent(text)}`} target="_blank" rel="noopener noreferrer">Preparar mensagem no WhatsApp</a>}
      </div></li>;
    })}</ul>
    <button onClick={dismiss}>Fechar lembrete</button>
  </dialog>;
}
