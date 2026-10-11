import { useEffect, useRef, useState } from 'react';
import { STAGES } from '../constants.js';
import { FOLLOW_UP_POLICY } from '../lib/followUpEngine.js';
import {
  sanitizeStagePolicyOverride,
  emptyStagePolicyForm,
  overrideToForm,
  formToOverride,
  validateStagePolicyForm,
  shouldSyncStagePolicyForm,
} from '../lib/followUpPolicyConfig.js';

// Etapa B — configuração de prazos de follow-up por etapa do funil.
// Puramente apresentacional + chamadas às funções puras de
// followUpPolicyConfig.js (toda a validação/sanitização/decisão de
// sincronização "de verdade" vive lá, testada sem React — este
// componente nunca reimplementa nenhuma regra própria).
//
// Nunca configurável aqui: Ganho/Perdido (o motor já os bloqueia
// incondicionalmente, ver followUpEngine.js) — excluídos da lista de
// etapas para nunca sugerir que configurar um prazo para eles teria
// algum efeito.
const CONFIGURABLE_STAGES = STAGES.filter((s) => s !== 'Ganho' && s !== 'Perdido');

const FIELD_LABELS = {
  attemptHours: 'Retorno após tentativa (h)',
  proposalHours: 'Retorno após proposta (h)',
  noNewAttemptHours: 'Parado após engajamento (h)',
  maxAttempts: 'Nº de tentativas',
  reactivationDays: 'Reativação (dias)',
};

export default function FollowUpPolicySettings({
  stagePolicyOverrides, loading, error, onRetry, onSave, onRemove,
}) {
  const [open, setOpen] = useState(false);
  const [selectedStage, setSelectedStage] = useState(CONFIGURABLE_STAGES[0]);
  const [form, setForm] = useState(emptyStagePolicyForm());
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  // Correção pós-revisão do PR #74 (achado CONFIRMED 2) —
  // `stagePolicyOverrides` chega de um fetch ASSÍNCRONO
  // (useAppState.js); o `useState` de `form` acima nunca é
  // reavaliado quando essa prop muda, então inicializar `form` só na
  // declaração do state deixava o formulário vazio mesmo quando já
  // havia uma configuração salva para a etapa exibida — e salvar
  // nesse estado zeraria (sobrescreveria) a configuração existente.
  // `initializedStageRef` guarda PARA QUAL etapa o `form` atual já
  // foi sincronizado a partir de dados reais; shouldSyncStagePolicyForm
  // (puro, testado) decide se é hora de sincronizar de novo — nunca
  // em cima de uma edição em andamento na MESMA etapa já
  // sincronizada (ex. o mapa de overrides mudar por outro motivo não
  // apaga o que o usuário está digitando).
  const initializedStageRef = useRef(null);
  useEffect(() => {
    if (!shouldSyncStagePolicyForm({ loading, selectedStage, initializedStage: initializedStageRef.current })) return;
    setForm(overrideToForm(stagePolicyOverrides[selectedStage] || {}));
    setFieldErrors({});
    initializedStageRef.current = selectedStage;
  }, [loading, selectedStage, stagePolicyOverrides]);

  function handleSelectStage(etapa) {
    setSelectedStage(etapa);
    setSaveError(null);
    // A sincronização em si acontece no efeito acima (etapa mudou ->
    // shouldSyncStagePolicyForm passa a devolver true) — aqui só
    // limpamos erros de campo da etapa anterior, nunca duplicamos a
    // lógica de preenchimento do formulário.
    setFieldErrors({});
  }

  function handleFieldChange(key, value) {
    setForm((prev) => ({ ...prev, [key]: value }));
    if (fieldErrors[key]) setFieldErrors((prev) => { const next = { ...prev }; delete next[key]; return next; });
  }

  async function handleSave() {
    // Achado 1 — validação ESPECÍFICA por campo ANTES de sanitizar:
    // um campo preenchido mas inválido bloqueia o salvamento inteiro
    // com uma mensagem própria, nunca é descartado silenciosamente
    // enquanto os demais campos válidos são salvos.
    const errors = validateStagePolicyForm(form);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    const override = sanitizeStagePolicyOverride(formToOverride(form));
    if (Object.keys(override).length === 0) {
      setSaveError('Preencha ao menos um prazo válido antes de salvar.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(selectedStage, override);
      // Reflete imediatamente o valor que de fato foi salvo (já
      // sanitizado) — nunca espera o round-trip das props para o
      // formulário mostrar o estado correto.
      setForm(overrideToForm(override));
      initializedStageRef.current = selectedStage;
    } catch (e) {
      setSaveError((e && e.message) || 'Não foi possível salvar esta configuração.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(etapa) {
    setSaving(true);
    setSaveError(null);
    try {
      await onRemove(etapa);
      if (etapa === selectedStage) {
        setForm(emptyStagePolicyForm());
        setFieldErrors({});
        initializedStageRef.current = selectedStage;
      }
    } catch (e) {
      setSaveError((e && e.message) || 'Não foi possível remover esta configuração.');
    } finally {
      setSaving(false);
    }
  }

  const configuredStages = Object.keys(stagePolicyOverrides);

  return (
    <section className="followup-section">
      <button type="button" className="btn-ghost" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Configurar prazos de follow-up por etapa
        {configuredStages.length > 0 && ` (${configuredStages.length} configurada${configuredStages.length === 1 ? '' : 's'})`}
      </button>

      {open && (
        <div style={{ marginTop: 10 }}>
          <p className="followup-subtitle">
            Prazos padrão (sem configuração): primeiro retorno em {FOLLOW_UP_POLICY.attempt.hoursUntilDue}h,
            pós-proposta em {FOLLOW_UP_POLICY.proposal.hoursUntilDue}h, parado após engajamento em {FOLLOW_UP_POLICY.noNewAttemptSinceEngagement.hoursUntilDue}h,
            {' '}{FOLLOW_UP_POLICY.maxAttempts} tentativas antes de reativação em {FOLLOW_UP_POLICY.reactivationAfterMaxAttempts.daysUntilDue} dias.
            Configurar uma etapa só muda os campos preenchidos abaixo — os demais continuam no padrão. Valores em horas/dias são sempre números inteiros.
          </p>

          {loading && <div className="empty-state">Carregando configuração...</div>}
          {!loading && error && (
            <div className="empty-state" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
              Não foi possível carregar a configuração de prazos.
              <div style={{ marginTop: 8 }}>
                <button type="button" className="btn-ghost" onClick={onRetry}>Tentar novamente</button>
              </div>
            </div>
          )}

          {!loading && !error && (
            <>
              <div className="add-task-form">
                <select value={selectedStage} onChange={(e) => handleSelectStage(e.target.value)} aria-label="Etapa do funil">
                  {CONFIGURABLE_STAGES.map((s) => (
                    <option key={s} value={s}>{s}{stagePolicyOverrides[s] ? ' •' : ''}</option>
                  ))}
                </select>
                <input
                  type="number" min="1" step="1" placeholder="Retorno após tentativa (h)"
                  aria-label={FIELD_LABELS.attemptHours}
                  value={form.attemptHours}
                  onChange={(e) => handleFieldChange('attemptHours', e.target.value)}
                />
                <input
                  type="number" min="1" step="1" placeholder="Retorno após proposta (h)"
                  aria-label={FIELD_LABELS.proposalHours}
                  value={form.proposalHours}
                  onChange={(e) => handleFieldChange('proposalHours', e.target.value)}
                />
                <input
                  type="number" min="1" step="1" placeholder="Parado após engajamento (h)"
                  aria-label={FIELD_LABELS.noNewAttemptHours}
                  value={form.noNewAttemptHours}
                  onChange={(e) => handleFieldChange('noNewAttemptHours', e.target.value)}
                />
                <input
                  type="number" min="1" step="1" placeholder="Nº de tentativas"
                  aria-label={FIELD_LABELS.maxAttempts}
                  value={form.maxAttempts}
                  onChange={(e) => handleFieldChange('maxAttempts', e.target.value)}
                />
                <input
                  type="number" min="1" step="1" placeholder="Reativação (dias)"
                  aria-label={FIELD_LABELS.reactivationDays}
                  value={form.reactivationDays}
                  onChange={(e) => handleFieldChange('reactivationDays', e.target.value)}
                />
                <button type="button" className="btn-primary" disabled={saving} onClick={handleSave}>
                  Salvar para {selectedStage}
                </button>
                {stagePolicyOverrides[selectedStage] && (
                  <button type="button" className="icon-btn" disabled={saving} onClick={() => handleRemove(selectedStage)}>
                    Voltar ao padrão
                  </button>
                )}
              </div>

              {/* Achado 1 — um erro por campo inválido, nunca um
                  aviso genérico só: o usuário sabe exatamente o que
                  corrigir, e o salvamento fica bloqueado até corrigir
                  TODOS. */}
              {Object.entries(fieldErrors).map(([key, message]) => (
                <div className="followup-warning" key={key}>{message}</div>
              ))}
              {saveError && <div className="followup-warning">{saveError}</div>}

              {configuredStages.length > 0 && (
                <div className="card-meta" style={{ marginTop: 10 }}>
                  Etapas com configuração própria: {configuredStages.join(', ')}.
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
