import { useCallback, useEffect, useRef, useState } from 'react';
import { DIAS_SEMANA } from '../constants.js';
import { todayStr } from '../utils.js';
import { leadsApi, tasksApi, templatesApi } from '../lib/db.js';
import { supabase } from '../lib/supabaseClient.js';

function pendingAutoTasksForLeads(leads, tasks) {
  const today = todayStr();
  const pending = [];
  leads.forEach((l) => {
    if (l.etapa === 'Ganho' || l.etapa === 'Perdido') return;
    if (!l.proximoContato) return;
    if (l.proximoContato > today) return;
    const jaTem = tasks.some((t) => t.leadId === l.id && t.origem === 'auto' && t.data === l.proximoContato)
      || pending.some((t) => t.leadId === l.id);
    if (!jaTem) {
      pending.push({ titulo: 'Follow-up: ' + l.nome, categoria: 'Follow-up', data: l.proximoContato, concluida: false, leadId: l.id, origem: 'auto' });
    }
  });
  return pending;
}

function pendingRotinaTasks(templates, tasks) {
  const todayAbrev = DIAS_SEMANA[new Date().getDay()];
  const today = todayStr();
  const pending = [];
  templates.forEach((tpl) => {
    if (!tpl.ativo) return;
    if (!tpl.dias.includes(todayAbrev)) return;
    const jaTem = tasks.some((t) => t.templateId === tpl.id && t.data === today)
      || pending.some((t) => t.templateId === tpl.id);
    if (!jaTem) {
      pending.push({ titulo: tpl.titulo, categoria: tpl.categoria, data: today, horario: tpl.horario || '', concluida: false, leadId: null, origem: 'rotina', templateId: tpl.id });
    }
  });
  return pending;
}

function computeLeadAgendaTaskData(lead) {
  const ativo = lead.etapa !== 'Ganho' && lead.etapa !== 'Perdido';
  if (!ativo || !lead.proximoContato) return null;
  return {
    titulo: 'Contato: ' + lead.nome,
    categoria: 'Agenda/Ligação',
    data: lead.proximoContato,
    horario: lead.proximoContatoHorario || '',
    concluida: false,
    leadId: lead.id,
    origem: 'lead-agenda',
  };
}

function reconcileLeadAgendaActions(affectedLeads, tasks) {
  const actions = [];
  affectedLeads.forEach((lead) => {
    const desired = computeLeadAgendaTaskData(lead);
    const existing = tasks.find((t) => t.origem === 'lead-agenda' && t.leadId === lead.id);
    if (!desired) {
      if (existing) actions.push({ type: 'delete', id: existing.id });
      return;
    }
    if (existing) {
      const changed = existing.titulo !== desired.titulo || existing.data !== desired.data || existing.horario !== desired.horario;
      if (changed) actions.push({ type: 'update', id: existing.id, data: desired });
    } else {
      actions.push({ type: 'insert', data: desired });
    }
  });
  return actions;
}

async function applyLeadAgendaActions(actions, setTasks) {
  for (const action of actions) {
    if (action.type === 'delete') {
      await tasksApi.remove(action.id);
      setTasks((prev) => prev.filter((t) => t.id !== action.id));
    } else if (action.type === 'update') {
      const updated = await tasksApi.update(action.id, action.data);
      setTasks((prev) => prev.map((t) => (t.id === action.id ? updated : t)));
    } else if (action.type === 'insert') {
      const inserted = await tasksApi.insert(action.data);
      setTasks((prev) => [...prev, inserted]);
    }
  }
}

function applyRealtimeChange(setState, fromRow, payload) {
  if (payload.eventType === 'DELETE') {
    setState((prev) => prev.filter((item) => item.id !== payload.old.id));
    return;
  }
  const row = fromRow(payload.new);
  setState((prev) => {
    const idx = prev.findIndex((item) => item.id === row.id);
    if (idx === -1) return [...prev, row];
    const next = prev.slice();
    next[idx] = row;
    return next;
  });
}

export function useAppState() {
  const [leads, setLeads] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const autoTasksChecked = useRef(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [leadsData, tasksData, templatesData] = await Promise.all([
          leadsApi.fetchAll(), tasksApi.fetchAll(), templatesApi.fetchAll(),
        ]);
        if (cancelled) return;
        setLeads(leadsData);
        setTasks(tasksData);
        setTemplates(templatesData);
        setLoading(false);

        if (!autoTasksChecked.current) {
          autoTasksChecked.current = true;
          const pending = [
            ...pendingAutoTasksForLeads(leadsData, tasksData),
            ...pendingRotinaTasks(templatesData, tasksData),
          ];
          for (const p of pending) {
            const inserted = await tasksApi.insert(p);
            if (cancelled) return;
            setTasks((prev) => [...prev, inserted]);
          }

          const leadAgendaActions = reconcileLeadAgendaActions(leadsData, tasksData);
          await applyLeadAgendaActions(leadAgendaActions, setTasks);
        }
      } catch (e) {
        if (!cancelled) { setError(e); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const channel = supabase
      .channel('crm-piccinini-sync')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'leads' }, (payload) => applyRealtimeChange(setLeads, leadsApi.fromRow, payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, (payload) => applyRealtimeChange(setTasks, tasksApi.fromRow, payload))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'templates' }, (payload) => applyRealtimeChange(setTemplates, templatesApi.fromRow, payload))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const saveLead = useCallback(async (id, data) => {
    const saved = id
      ? await leadsApi.update(id, { ...data, ultimaAtualizacao: todayStr() })
      : await leadsApi.insert({ ...data, criadoEm: todayStr(), ultimaAtualizacao: todayStr() });
    setLeads((prev) => (id ? prev.map((l) => (l.id === id ? saved : l)) : [...prev, saved]));
    const pending = pendingAutoTasksForLeads([saved], tasks);
    for (const p of pending) {
      const inserted = await tasksApi.insert(p);
      setTasks((prev) => [...prev, inserted]);
    }
    await applyLeadAgendaActions(reconcileLeadAgendaActions([saved], tasks), setTasks);
  }, [tasks]);

  const deleteLead = useCallback(async (id) => {
    const relatedTasks = tasks.filter((t) => t.leadId === id);
    await Promise.all(relatedTasks.map((t) => tasksApi.remove(t.id)));
    await leadsApi.remove(id);
    setLeads((prev) => prev.filter((l) => l.id !== id));
    setTasks((prev) => prev.filter((t) => t.leadId !== id));
  }, [tasks]);

  const moveStage = useCallback(async (id, dir, STAGES) => {
    const lead = leads.find((l) => l.id === id);
    if (!lead) return;
    const idx = STAGES.indexOf(lead.etapa);
    const next = idx + dir;
    if (next < 0 || next >= STAGES.length) return;
    const updated = await leadsApi.update(id, { ...lead, etapa: STAGES[next], ultimaAtualizacao: todayStr() });
    setLeads((prev) => prev.map((l) => (l.id === id ? updated : l)));
    await applyLeadAgendaActions(reconcileLeadAgendaActions([updated], tasks), setTasks);
  }, [leads, tasks]);

  const addTask = useCallback(async (titulo, categoria, data, horario) => {
    const inserted = await tasksApi.insert({ titulo, categoria, data, horario, concluida: false, leadId: null, origem: 'manual' });
    setTasks((prev) => [...prev, inserted]);
  }, []);

  const toggleTask = useCallback(async (id) => {
    const t = tasks.find((x) => x.id === id);
    if (!t) return;
    const updated = await tasksApi.update(id, { ...t, concluida: !t.concluida });
    setTasks((prev) => prev.map((x) => (x.id === id ? updated : x)));
  }, [tasks]);

  const deleteTask = useCallback(async (id) => {
    await tasksApi.remove(id);
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addRotina = useCallback(async (titulo, categoria, horario, dias) => {
    const sortedDias = [...dias].sort((a, b) => DIAS_SEMANA.indexOf(a) - DIAS_SEMANA.indexOf(b));
    const tpl = await templatesApi.insert({ titulo, categoria, horario, dias: sortedDias, ativo: true });
    setTemplates((prev) => [...prev, tpl]);
    const pending = pendingRotinaTasks([tpl], tasks);
    for (const p of pending) {
      const inserted = await tasksApi.insert(p);
      setTasks((prev) => [...prev, inserted]);
    }
  }, [tasks]);

  const toggleRotinaAtiva = useCallback(async (id) => {
    const tpl = templates.find((t) => t.id === id);
    if (!tpl) return;
    const updated = await templatesApi.update(id, { ...tpl, ativo: !tpl.ativo });
    setTemplates((prev) => prev.map((t) => (t.id === id ? updated : t)));
    if (updated.ativo) {
      const pending = pendingRotinaTasks([updated], tasks);
      for (const p of pending) {
        const inserted = await tasksApi.insert(p);
        setTasks((prev) => [...prev, inserted]);
      }
    }
  }, [templates, tasks]);

  const deleteRotina = useCallback(async (id) => {
    await templatesApi.remove(id);
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const importBackup = useCallback(async (backup) => {
    await Promise.all(tasks.map((t) => tasksApi.remove(t.id)));
    await Promise.all(leads.map((l) => leadsApi.remove(l.id)));
    await Promise.all(templates.map((t) => templatesApi.remove(t.id)));

    const leadIdMap = new Map();
    const newLeads = [];
    for (const l of backup.leads || []) {
      const inserted = await leadsApi.insert(l);
      leadIdMap.set(l.id, inserted.id);
      newLeads.push(inserted);
    }

    const templateIdMap = new Map();
    const newTemplates = [];
    for (const tpl of backup.templates || []) {
      const inserted = await templatesApi.insert(tpl);
      templateIdMap.set(tpl.id, inserted.id);
      newTemplates.push(inserted);
    }

    const newTasks = [];
    for (const t of backup.tasks || []) {
      const inserted = await tasksApi.insert({
        ...t,
        leadId: t.leadId ? leadIdMap.get(t.leadId) || null : null,
        templateId: t.templateId ? templateIdMap.get(t.templateId) || null : null,
      });
      newTasks.push(inserted);
    }

    setLeads(newLeads);
    setTemplates(newTemplates);
    setTasks(newTasks);
  }, [leads, tasks, templates]);

  return {
    leads, tasks, templates, loading, error,
    saveLead, deleteLead, moveStage,
    addTask, toggleTask, deleteTask,
    addRotina, toggleRotinaAtiva, deleteRotina,
    importBackup,
  };
}
