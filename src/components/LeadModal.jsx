import { useEffect, useMemo, useState } from 'react';
import {
  CANAIS, PRODUTOS, STAGES, TAGS_LEAD, TAG_COLOR,
  NEXT_ACTION_TYPES, LEAD_TEMPERATURES, PRIORITIES, LOST_REASONS,
} from '../constants.js';
import { availableTimeSlots, formatPhoneBR, formatRelativeTime, moneyFormat, parseMoneyValue } from '../utils.js';
import { interactionsApi } from '../lib/db.js';
import { computeLastActivityAt, computeLastContactAttemptAt, computeLastCustomerEngagementAt } from '../hooks/useAppState.js';
import ProdutoFields from './ProdutoFields.jsx';
import LeadTimeline from './LeadTimeline.jsx';

function fmtAbsolute(iso) {
  return iso ? new Date(iso).toLocaleString('pt-BR') : undefined;
}

const EMPTY_EXTRA = { tipo: '', credito: '', entrada: '', parcela: '', lance: '', valor: '', valorImovel: '' };

function extraFromLead(lead) {
  if (!lead) return { ...EMPTY_EXTRA };
  return {
    tipo: lead.tipo || '',
    credito: moneyFormat(lead.credito),
    entrada: moneyFormat(lead.entrada),
    parcela: moneyFormat(lead.parcela),
    lance: moneyFormat(lead.lance),
    valor: moneyFormat(lead.valor),
    valorImovel: moneyFormat(lead.valorImovel),
  };
}

export default function LeadModal({ lead, tasks, onClose, onSave, onAddInteractionNote, onRegisterCommercialInteraction }) {
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [cidade, setCidade] = useState('');
  const [canal, setCanal] = useState(CANAIS[0]);
  const [produto, setProduto] = useState(PRODUTOS[0]);
  const [etapa, setEtapa] = useState(STAGES[0]);
  const [proximoContato, setProximoContato] = useState('');
  const [proximoContatoHorario, setProximoContatoHorario] = useState('');
  const [notas, setNotas] = useState('');
  const [tags, setTags] = useState([]);
  const [extra, setExtra] = useState({ ...EMPTY_EXTRA });
  const [error, setError] = useState('');
  const [nextActionType, setNextActionType] = useState('');
  const [nextActionNote, setNextActionNote] = useState('');
  const [leadTemperature, setLeadTemperature] = useState('');
  const [priority, setPriority] = useState('normal');
  const [lostReason, setLostReason] = useState('');
  const [lostReasonNote, setLostReasonNote] = useState('');
  const [interactions, setInteractions] = useState([]);
  const [interactionsLoading, setInteractionsLoading] = useState(true);
  const [interactionsError, setInteractionsError] = useState(false);

  // Fase 2B — içado de LeadTimeline: o modal passa a ser a única fonte de
  // estado das interações do lead aberto, usada tanto pela lista do
  // histórico quanto pelos três relógios de atividade (useMemo abaixo),
  // sem fetch duplicado.
  useEffect(() => {
    if (!lead) { setInteractions([]); return; }
    let cancelled = false;
    setInteractionsLoading(true);
    setInteractionsError(false);
    interactionsApi.fetchForLead(lead.id)
      .then((data) => { if (!cancelled) { setInteractions(data); setInteractionsLoading(false); } })
      .catch(() => { if (!cancelled) { setInteractionsError(true); setInteractionsLoading(false); } });
    return () => { cancelled = true; };
  }, [lead?.id]);

  function handleInteractionAdded(inserted) {
    setInteractions((prev) => [inserted, ...prev]);
  }

  const lastActivityAt = useMemo(() => computeLastActivityAt(interactions), [interactions]);
  const lastContactAttemptAt = useMemo(() => computeLastContactAttemptAt(interactions), [interactions]);
  const lastCustomerEngagementAt = useMemo(() => computeLastCustomerEngagementAt(interactions), [interactions]);

  useEffect(() => {
    setNome(lead ? lead.nome : '');
    setTelefone(lead ? formatPhoneBR(lead.telefone) : '');
    setCidade(lead ? lead.cidade || '' : '');
    setCanal(lead ? lead.canal : CANAIS[0]);
    setProduto(lead ? lead.produto : PRODUTOS[0]);
    setEtapa(lead ? lead.etapa : STAGES[0]);
    setProximoContato(lead ? lead.proximoContato || '' : '');
    setProximoContatoHorario(lead ? lead.proximoContatoHorario || '' : '');
    setNotas(lead ? lead.notas || '' : '');
    setTags(lead ? lead.tags || [] : []);
    setExtra(extraFromLead(lead));
    setNextActionType(lead ? lead.nextActionType || '' : '');
    setNextActionNote(lead ? lead.nextActionNote || '' : '');
    setLeadTemperature(lead ? lead.leadTemperature || '' : '');
    setPriority(lead ? lead.priority || 'normal' : 'normal');
    setLostReason(lead ? lead.lostReason || '' : '');
    setLostReasonNote(lead ? lead.lostReasonNote || '' : '');
    setError('');
  }, [lead]);

  const availableSlots = useMemo(() => {
    if (!proximoContato) return [];
    const occupied = tasks
      .filter((t) => t.data === proximoContato && t.horario && !(lead && t.origem === 'lead-agenda' && t.leadId === lead.id))
      .map((t) => t.horario);
    return availableTimeSlots(occupied);
  }, [tasks, proximoContato, lead]);

  function toggleTag(tag) {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  function handleProdutoChange(novoProduto) {
    setProduto(novoProduto);
    setExtra({ ...EMPTY_EXTRA, tipo: extra.tipo });
  }

  function buildExtraForSave() {
    if (produto === 'Carta Contemplada') {
      return { tipo: extra.tipo, credito: parseMoneyValue(extra.credito), entrada: parseMoneyValue(extra.entrada), parcela: parseMoneyValue(extra.parcela), lance: null, valor: null, valorImovel: null };
    }
    if (produto === 'Consórcio') {
      return { tipo: extra.tipo, credito: parseMoneyValue(extra.credito), parcela: parseMoneyValue(extra.parcela), lance: parseMoneyValue(extra.lance), entrada: null, valor: null, valorImovel: null };
    }
    if (produto === 'Home Equity') {
      return { valor: parseMoneyValue(extra.valor), valorImovel: parseMoneyValue(extra.valorImovel), tipo: null, credito: null, entrada: null, parcela: null, lance: null };
    }
    if (produto === 'Financiamento') {
      return { tipo: extra.tipo, valor: parseMoneyValue(extra.valor), entrada: parseMoneyValue(extra.entrada), parcela: parseMoneyValue(extra.parcela), credito: null, lance: null, valorImovel: null };
    }
    return { valor: parseMoneyValue(extra.valor), tipo: null, credito: null, entrada: null, parcela: null, lance: null, valorImovel: null };
  }

  function handleSave() {
    const nomeTrim = nome.trim();
    if (!nomeTrim) {
      setError('Preencha o nome do lead antes de salvar.');
      return;
    }
    const data = {
      nome: nomeTrim,
      telefone: telefone.trim(),
      cidade: cidade.trim(),
      canal,
      produto,
      etapa,
      proximoContato,
      proximoContatoHorario: proximoContato ? proximoContatoHorario : '',
      notas: notas.trim(),
      tags,
      nextActionType,
      nextActionNote: nextActionNote.trim(),
      leadTemperature,
      priority,
      lostReason: etapa === 'Perdido' ? lostReason : '',
      lostReasonNote: etapa === 'Perdido' ? lostReasonNote.trim() : '',
      ...buildExtraForSave(),
    };
    onSave(lead ? lead.id : null, data);
  }

  return (
    <div className="overlay show">
      <div className="modal">
        <h2>{lead ? 'Editar lead' : 'Novo Lead'}</h2>
        {error && (
          <div style={{ display: 'block', background: '#2a1418', border: '1px solid var(--red)', color: 'var(--red)', padding: '8px 12px', borderRadius: 8, fontSize: 12.5, marginBottom: 12 }}>
            {error}
          </div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); handleSave(); }}>
          <div className="field">
            <label htmlFor="f-nome">Nome</label>
            <input type="text" id="f-nome" value={nome} onChange={(e) => setNome(e.target.value)} />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="f-telefone">Telefone</label>
              <input type="text" inputMode="numeric" id="f-telefone" placeholder="(54) 9 9999-9999" value={telefone} onChange={(e) => setTelefone(formatPhoneBR(e.target.value))} />
            </div>
            <div className="field">
              <label htmlFor="f-cidade">Cidade</label>
              <input type="text" id="f-cidade" placeholder="Ex: Erechim" value={cidade} onChange={(e) => setCidade(e.target.value)} />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="f-canal">Canal</label>
              <select id="f-canal" value={canal} onChange={(e) => setCanal(e.target.value)}>
                {CANAIS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="f-produto">Produto</label>
              <select id="f-produto" value={produto} onChange={(e) => handleProdutoChange(e.target.value)}>
                {PRODUTOS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-etapa">Etapa</label>
              <select id="f-etapa" value={etapa} onChange={(e) => setEtapa(e.target.value)}>
                {STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label>Temperatura</label>
              <div className="filters" style={{ marginBottom: 0 }}>
                {LEAD_TEMPERATURES.map((t) => {
                  const active = leadTemperature === t.value;
                  return (
                    <button
                      type="button"
                      key={t.value}
                      className={`chip ${active ? 'active' : ''}`}
                      style={active ? { background: t.color, color: '#fff', borderColor: 'transparent' } : undefined}
                      onClick={() => setLeadTemperature(active ? '' : t.value)}
                    >
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="field">
              <label htmlFor="f-prioridade">Prioridade</label>
              <select id="f-prioridade" value={priority} onChange={(e) => setPriority(e.target.value)}>
                {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
          </div>
          {etapa === 'Perdido' && (
            <div className="field-row">
              <div className="field">
                <label htmlFor="f-lost-reason">Motivo de perda</label>
                <select id="f-lost-reason" value={lostReason} onChange={(e) => setLostReason(e.target.value)}>
                  <option value="">Selecione...</option>
                  {LOST_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="f-lost-note">Observação</label>
                <input type="text" id="f-lost-note" value={lostReasonNote} onChange={(e) => setLostReasonNote(e.target.value)} />
              </div>
            </div>
          )}
          <ProdutoFields produto={produto} extra={extra} onExtraChange={setExtra} />
          <div className="field-row">
            <div className="field">
              <label htmlFor="f-proximo">Próximo contato</label>
              <input type="date" id="f-proximo" value={proximoContato} onChange={(e) => setProximoContato(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="f-proximo-horario">Horário</label>
              <input type="time" id="f-proximo-horario" value={proximoContatoHorario} onChange={(e) => setProximoContatoHorario(e.target.value)} disabled={!proximoContato} />
            </div>
          </div>
          {proximoContato && (
            <div className="field">
              <label>Horários disponíveis nesse dia</label>
              <div className="filters" style={{ marginBottom: 0 }}>
                {availableSlots.length === 0 ? (
                  <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>Nenhum horário livre nesse dia (considerando 08h-12h e 13h-18h).</span>
                ) : (
                  availableSlots.map((slot) => (
                    <button
                      type="button"
                      key={slot}
                      className={`chip ${proximoContatoHorario === slot ? 'active' : ''}`}
                      onClick={() => setProximoContatoHorario(slot)}
                    >
                      {slot}
                    </button>
                  ))
                )}
              </div>
            </div>
          )}
          <div className="field-row">
            <div className="field">
              <label htmlFor="f-next-action-type">Próxima ação</label>
              <select id="f-next-action-type" value={nextActionType} onChange={(e) => setNextActionType(e.target.value)}>
                <option value="">Não definida</option>
                {NEXT_ACTION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="f-next-action-note">O que precisa ser feito</label>
              <input
                type="text"
                id="f-next-action-note"
                placeholder="Ex: Retomar proposta após conversar com a esposa"
                value={nextActionNote}
                onChange={(e) => setNextActionNote(e.target.value)}
              />
            </div>
          </div>
          {lead && (
            <div className="field">
              <label>Atividade</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12.5, color: 'var(--text-dim)' }}>
                <div title={fmtAbsolute(lastActivityAt)}>Última atividade: {formatRelativeTime(lastActivityAt)}</div>
                <div title={fmtAbsolute(lastContactAttemptAt)}>Última tentativa: {formatRelativeTime(lastContactAttemptAt)}</div>
                <div title={fmtAbsolute(lastCustomerEngagementAt)}>Último engajamento: {formatRelativeTime(lastCustomerEngagementAt)}</div>
              </div>
            </div>
          )}
          <div className="field">
            <label>Tags</label>
            <div className="filters" style={{ marginBottom: 0 }}>
              {TAGS_LEAD.map((tag) => {
                const active = tags.includes(tag);
                return (
                  <button
                    type="button"
                    key={tag}
                    className={`chip ${active ? 'active' : ''}`}
                    style={active ? { background: TAG_COLOR[tag] || 'var(--blue)', color: '#fff', borderColor: 'transparent' } : undefined}
                    onClick={() => toggleTag(tag)}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="field">
            <label htmlFor="f-notas">Notas</label>
            <textarea id="f-notas" rows={3} value={notas} onChange={(e) => setNotas(e.target.value)} />
          </div>
          {lead && (
            <LeadTimeline
              leadId={lead.id}
              interactions={interactions}
              loading={interactionsLoading}
              error={interactionsError}
              onInteractionAdded={handleInteractionAdded}
              onAddNote={onAddInteractionNote}
              onRegisterInteraction={onRegisterCommercialInteraction}
            />
          )}
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
            <button type="button" className="btn-primary" onClick={handleSave}>Salvar lead</button>
          </div>
        </form>
      </div>
    </div>
  );
}
