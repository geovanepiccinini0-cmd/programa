import { useEffect, useMemo, useState } from 'react';
import { CANAIS, PRODUTOS, STAGES } from '../constants.js';
import { availableTimeSlots, formatPhoneBR, moneyFormat, parseMoneyValue } from '../utils.js';
import ProdutoFields from './ProdutoFields.jsx';

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

export default function LeadModal({ lead, tasks, onClose, onSave }) {
  const [nome, setNome] = useState('');
  const [telefone, setTelefone] = useState('');
  const [cidade, setCidade] = useState('');
  const [canal, setCanal] = useState(CANAIS[0]);
  const [produto, setProduto] = useState(PRODUTOS[0]);
  const [etapa, setEtapa] = useState(STAGES[0]);
  const [proximoContato, setProximoContato] = useState('');
  const [proximoContatoHorario, setProximoContatoHorario] = useState('');
  const [notas, setNotas] = useState('');
  const [extra, setExtra] = useState({ ...EMPTY_EXTRA });
  const [error, setError] = useState('');

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
    setExtra(extraFromLead(lead));
    setError('');
  }, [lead]);

  const availableSlots = useMemo(() => {
    if (!proximoContato) return [];
    const occupied = tasks
      .filter((t) => t.data === proximoContato && t.horario && !(lead && t.origem === 'lead-agenda' && t.leadId === lead.id))
      .map((t) => t.horario);
    return availableTimeSlots(occupied);
  }, [tasks, proximoContato, lead]);

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
          <div className="field">
            <label htmlFor="f-notas">Notas</label>
            <textarea id="f-notas" rows={3} value={notas} onChange={(e) => setNotas(e.target.value)} />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn-ghost" onClick={onClose}>Cancelar</button>
            <button type="button" className="btn-primary" onClick={handleSave}>Salvar lead</button>
          </div>
        </form>
      </div>
    </div>
  );
}
