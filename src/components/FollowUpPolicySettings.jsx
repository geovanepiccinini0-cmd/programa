import { useState } from 'react';
import { STAGES } from '../constants.js';
import { FOLLOW_UP_POLICY } from '../lib/followUpEngine.js';
import { sanitizeStagePolicyOverride } from '../lib/followUpPolicyConfig.js';

// Etapa B — configuração de prazos de follow-up por etapa do funil.
// Puramente apresentacional + validação de formulário: toda a
// sanitização "de verdade" (a que decide o que o motor realmente usa)
// é feita por sanitizeStagePolicyOverride (followUpPolicyConfig.js,
// puro, testado) — este componente só chama a MESMA função antes de
// salvar, para dar feedback imediato ao usuário (nunca uma segunda
// regra de validação divergente).
//
// Nunca configurável aqui: Ganho/Perdido (o motor já os bloqueia
// incondicionalmente, ver followUpEngine.js) — excluídos da lista de
// etapas para nunca sugerir que configurar um prazo para eles teria
// algum efeito.
const CONFIGURABLE_STAGES = STAGES.filter((s) => s !== 'Ganho' && s !== 'Perdido');

function emptyForm() {
  return { attemptHours: '', proposalHours: '', noNewAttemptHours: '', maxAttempts: '', reactivationDays: '' };
}

// Converte o formulário (strings de <input>) para a forma aninhada
// que sanitizeStagePolicyOverride/followUpStagePoliciesApi.save
// esperam. Campo vazio = "não configurar este campo" (fica de fora do
// objeto, nunca um 0/NaN que pareceria um valor real).
function formToOverride(form) {
  const override = {};
  if (form.attemptHours !== '') override.attempt = { hoursUntilDue: Number(form.attemptHours) };
  if (form.proposalHours !== '') override.proposal = { hoursUntilDue: Number(form.proposalHours) };
  if (form.noNewAttemptHours !== '') override.noNewAttemptSinceEngagement = { hoursUntilDue: Number(form.noNewAttemptHours) };
  if (form.maxAttempts !== '') override.maxAttempts = Number(form.maxAttempts);
  if (form.reactivationDays !== '') override.reactivationAfterMaxAttempts = { daysUntilDue: Number(form.reactivationDays) };
  return override;
}

function overrideToForm(override) {
  const form = emptyForm();
  if (override.attempt) form.attemptHours = String(override.attempt.hoursUntilDue);
  if (override.proposal) form.proposalHours = String(override.proposal.hoursUntilDue);
  if (override.noNewAttemptSinceEngagement) form.noNewAttemptHours = String(override.noNewAttemptSinceEngagement.hoursUntilDue);
  if (typeof override.maxAttempts === 'number') form.maxAttempts = String(override.maxAttempts);
  if (override.reactivationAfterMaxAttempts) form.reactivationDays = String(override.reactivationAfterMaxAttempts.daysUntilDue);
  return form;
}

export default function FollowUpPolicySettings({
  stagePolicyOverrides, loading, error, onRetry, onSave, onRemove,
}) {
  const [open, setOpen] = useState(false);
  const [selectedStage, setSelectedStage] = useState(CONFIGURABLE_STAGES[0]);
  const [form, setForm] = useState(overrideToForm(stagePolicyOverrides[CONFIGURABLE_STAGES[0]] || {}));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  function handleSelectStage(etapa) {
    setSelectedStage(etapa);
    setForm(overrideToForm(stagePolicyOverrides[etapa] || {}));
    setSaveError(null);
  }

  async function handleSave() {
    const override = sanitizeStagePolicyOverride(formToOverride(form));
    if (Object.keys(override).length === 0) {
      setSaveError('Preencha ao menos um prazo válido antes de salvar.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(selectedStage, override);
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
      if (etapa === selectedStage) setForm(emptyForm());
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
            Configurar uma etapa só muda os campos preenchidos abaixo — os demais continuam no padrão.
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
                  type="number" min="1" placeholder="Retorno após tentativa (h)"
                  aria-label="Prazo de retorno após tentativa, em horas"
                  value={form.attemptHours}
                  onChange={(e) => setForm({ ...form, attemptHours: e.target.value })}
                />
                <input
                  type="number" min="1" placeholder="Retorno após proposta (h)"
                  aria-label="Prazo de retorno após proposta, em horas"
                  value={form.proposalHours}
                  onChange={(e) => setForm({ ...form, proposalHours: e.target.value })}
                />
                <input
                  type="number" min="1" placeholder="Parado após engajamento (h)"
                  aria-label="Prazo sem nova tentativa após engajamento, em horas"
                  value={form.noNewAttemptHours}
                  onChange={(e) => setForm({ ...form, noNewAttemptHours: e.target.value })}
                />
                <input
                  type="number" min="1" placeholder="Nº de tentativas"
                  aria-label="Número de tentativas antes de considerar a cadência esgotada"
                  value={form.maxAttempts}
                  onChange={(e) => setForm({ ...form, maxAttempts: e.target.value })}
                />
                <input
                  type="number" min="1" placeholder="Reativação (dias)"
                  aria-label="Prazo de reativação após a cadência esgotada, em dias"
                  value={form.reactivationDays}
                  onChange={(e) => setForm({ ...form, reactivationDays: e.target.value })}
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
