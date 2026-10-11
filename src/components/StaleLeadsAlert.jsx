import { getStaleLeads, formatStaleDaysLabel } from '../utils.js';

// Etapa A — alerta visual de leads sem movimentação (ver diagnóstico
// técnico). Puramente apresentacional: toda a classificação vem de
// getStaleLeads/classifyLeadPriority (utils.js) — este componente
// nunca decide por conta própria quem é "parado", nunca cria/altera
// task ou interação, nunca escreve nada. Abrir o cadastro reaproveita
// o MESMO fluxo já usado em toda a aplicação (onEditLead -> LeadModal
// via App.jsx), nenhuma rota nova.
//
// DISTINÇÃO EXPLÍCITA (requisito 6 da autorização, revisada após
// comentário técnico do PR #73): "parado" é calculado SÓ a partir de
// leads.ultima_atualizacao (ou criado_em, se a primeira estiver
// vazia) — nunca a partir de lead_interactions/histórico comercial.
// Por isso é um eixo independente de follow-up 'due'
// (followUpEngine.js, que sim lê o histórico de interações): os dois
// podem discordar em qualquer direção — um lead pode estar parado
// (cadastro sem edição há STALE_DAYS) mesmo tendo tido uma ligação
// ontem que não gerou nenhuma edição de cadastro, e pode ter um
// follow-up vencido mesmo com o cadastro editado recentemente. Este
// bloco nunca lê evaluateFollowUpEligibility/buildFollowUpQueue nem
// lead_interactions, tem título e cor próprios (nunca o mesmo texto
// "Sugestão"/"Precisa de ação" da fila de follow-up), e nunca gera
// nenhuma tarefa — é somente leitura.
export default function StaleLeadsAlert({ leads, onEditLead }) {
  const staleLeads = getStaleLeads(leads);

  if (staleLeads.length === 0) return null;

  return (
    <section className="followup-section" aria-label="Leads sem movimentação">
      <h2 className="section-title" style={{ marginTop: 0, paddingTop: 0, borderTop: 'none' }}>
        Leads sem movimentação ({staleLeads.length})
      </h2>
      <p className="followup-subtitle">
        Sem nenhuma atualização de cadastro há muito tempo — considere entrar em contato ou revisar a etapa.
      </p>
      <div className="followup-list">
        {staleLeads.map((lead) => {
          const label = formatStaleDaysLabel(lead);
          const etapaProduto = [lead.etapa, lead.produto].filter(Boolean).join(' · ');
          return (
            <button
              type="button"
              key={lead.id}
              className="followup-card compact"
              onClick={() => onEditLead(lead)}
            >
              <div className="followup-card-top">
                <span className="followup-card-nome">{lead.nome}</span>
              </div>
              {label && <div className="card-meta">{label}</div>}
              {etapaProduto && <div className="card-meta">{etapaProduto}</div>}
            </button>
          );
        })}
      </div>
    </section>
  );
}
