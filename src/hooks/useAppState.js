import { useCallback, useEffect, useRef, useState } from 'react';
import { DIAS_SEMANA } from '../constants.js';
import { todayStr, uid } from '../utils.js';

const STORAGE_KEYS = { leads: 'crm-piccinini:leads', tasks: 'crm-piccinini:tasks', templates: 'crm-piccinini:templates' };

function loadFromStorage(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('Erro ao ler storage', key, e);
    return [];
  }
}

function saveToStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.error('Erro ao salvar storage', key, e);
    return false;
  }
}

function generateAutoTasks(leads, tasks) {
  const today = todayStr();
  const newTasks = [];
  leads.forEach((l) => {
    if (l.etapa === 'Ganho' || l.etapa === 'Perdido') return;
    if (!l.proximoContato) return;
    if (l.proximoContato > today) return;
    const jaTem = tasks.some((t) => t.leadId === l.id && t.origem === 'auto' && !t.concluida)
      || newTasks.some((t) => t.leadId === l.id && t.origem === 'auto' && !t.concluida);
    if (!jaTem) {
      newTasks.push({ id: uid(), titulo: 'Follow-up: ' + l.nome, categoria: 'Follow-up', data: l.proximoContato, concluida: false, leadId: l.id, origem: 'auto' });
    }
  });
  return newTasks;
}

function generateAutoTaskForLead(lead, tasks) {
  return generateAutoTasks([lead], tasks);
}

function generateRotinaTasks(templates, tasks) {
  const todayAbrev = DIAS_SEMANA[new Date().getDay()];
  const today = todayStr();
  const newTasks = [];
  templates.forEach((tpl) => {
    if (!tpl.ativo) return;
    if (!tpl.dias.includes(todayAbrev)) return;
    const jaTem = tasks.some((t) => t.templateId === tpl.id && t.data === today)
      || newTasks.some((t) => t.templateId === tpl.id && t.data === today);
    if (!jaTem) {
      const titulo = tpl.horario ? `${tpl.horario} · ${tpl.titulo}` : tpl.titulo;
      newTasks.push({ id: uid(), titulo, categoria: tpl.categoria, data: today, concluida: false, leadId: null, origem: 'rotina', templateId: tpl.id });
    }
  });
  return newTasks;
}

export function useAppState() {
  const [leads, setLeads] = useState(() => loadFromStorage(STORAGE_KEYS.leads));
  const [tasks, setTasks] = useState(() => loadFromStorage(STORAGE_KEYS.tasks));
  const [templates, setTemplates] = useState(() => loadFromStorage(STORAGE_KEYS.templates));
  const initialized = useRef(false);

  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    setTasks((prevTasks) => {
      const autoTasks = generateAutoTasks(leads, prevTasks);
      const rotinaTasks = generateRotinaTasks(templates, [...prevTasks, ...autoTasks]);
      return [...prevTasks, ...autoTasks, ...rotinaTasks];
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { saveToStorage(STORAGE_KEYS.leads, leads); }, [leads]);
  useEffect(() => { saveToStorage(STORAGE_KEYS.tasks, tasks); }, [tasks]);
  useEffect(() => { saveToStorage(STORAGE_KEYS.templates, templates); }, [templates]);

  const saveLead = useCallback((id, data) => {
    let savedLead = null;
    setLeads((prev) => {
      if (id) {
        return prev.map((l) => {
          if (l.id !== id) return l;
          savedLead = { ...l, ...data, ultimaAtualizacao: todayStr() };
          return savedLead;
        });
      }
      savedLead = { id: uid(), criadoEm: todayStr(), ultimaAtualizacao: todayStr(), ...data };
      return [...prev, savedLead];
    });
    setTasks((prev) => [...prev, ...generateAutoTaskForLead(savedLead, prev)]);
  }, []);

  const deleteLead = useCallback((id) => {
    setLeads((prev) => prev.filter((l) => l.id !== id));
    setTasks((prev) => prev.filter((t) => t.leadId !== id));
  }, []);

  const moveStage = useCallback((id, dir, STAGES) => {
    setLeads((prev) => prev.map((l) => {
      if (l.id !== id) return l;
      const idx = STAGES.indexOf(l.etapa);
      const next = idx + dir;
      if (next < 0 || next >= STAGES.length) return l;
      return { ...l, etapa: STAGES[next], ultimaAtualizacao: todayStr() };
    }));
  }, []);

  const addTask = useCallback((titulo, categoria, data, horario) => {
    setTasks((prev) => [...prev, { id: uid(), titulo, categoria, data, horario: horario || '', concluida: false, leadId: null, origem: 'manual' }]);
  }, []);

  const toggleTask = useCallback((id) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, concluida: !t.concluida } : t)));
  }, []);

  const deleteTask = useCallback((id) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addRotina = useCallback((titulo, categoria, horario, dias) => {
    const tpl = { id: uid(), titulo, categoria, horario: horario || '', dias: [...dias].sort((a, b) => DIAS_SEMANA.indexOf(a) - DIAS_SEMANA.indexOf(b)), ativo: true };
    setTemplates((prev) => [...prev, tpl]);
    setTasks((prev) => [...prev, ...generateRotinaTasks([tpl], prev)]);
  }, []);

  const toggleRotinaAtiva = useCallback((id) => {
    setTemplates((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, ativo: !t.ativo } : t));
      const tpl = next.find((t) => t.id === id);
      if (tpl && tpl.ativo) {
        setTasks((prevTasks) => [...prevTasks, ...generateRotinaTasks([tpl], prevTasks)]);
      }
      return next;
    });
  }, []);

  const deleteRotina = useCallback((id) => {
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const importBackup = useCallback((backup) => {
    setLeads(backup.leads || []);
    setTasks(backup.tasks || []);
    setTemplates(backup.templates || []);
  }, []);

  return {
    leads, tasks, templates,
    saveLead, deleteLead, moveStage,
    addTask, toggleTask, deleteTask,
    addRotina, toggleRotinaAtiva, deleteRotina,
    importBackup,
  };
}
