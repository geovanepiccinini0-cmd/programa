import { useEffect, useRef, useState } from 'react';
import { todayStr, upcomingAppointments } from '../utils.js';

const ALERT_WINDOW_MINUTES = 30;
const CHECK_INTERVAL_MS = 30000;

function notifiedKey(taskId) {
  return `crm-piccinini-notified-${todayStr()}-${taskId}`;
}

export function useAppointmentAlerts(tasks, leads) {
  const [upcoming, setUpcoming] = useState([]);
  const [dismissed, setDismissed] = useState(() => new Set());
  const [permission, setPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported',
  );
  const tasksRef = useRef(tasks);
  const leadsRef = useRef(leads);
  tasksRef.current = tasks;
  leadsRef.current = leads;

  useEffect(() => {
    function check() {
      const found = upcomingAppointments(tasksRef.current, ALERT_WINDOW_MINUTES);
      setUpcoming(found);

      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        found.forEach(({ task, minutesLeft }) => {
          const key = notifiedKey(task.id);
          if (localStorage.getItem(key)) return;
          const lead = task.leadId ? leadsRef.current.find((l) => l.id === task.leadId) : null;
          const corpo = lead ? `${lead.nome}${lead.telefone ? ' · ' + lead.telefone : ''}` : task.titulo;
          new Notification(`Atendimento em ${minutesLeft} min`, { body: corpo, tag: key });
          localStorage.setItem(key, '1');
        });
      }
    }
    check();
    const id = setInterval(check, CHECK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  function requestPermission() {
    if (typeof Notification === 'undefined') return;
    Notification.requestPermission().then(setPermission);
  }

  function dismiss(taskId) {
    setDismissed((prev) => new Set(prev).add(taskId));
  }

  const visible = upcoming.filter(({ task }) => !dismissed.has(task.id));

  return { upcoming: visible, permission, requestPermission, dismiss };
}
