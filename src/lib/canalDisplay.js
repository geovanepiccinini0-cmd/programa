// Fase 3.5.1 — Mapeamento de exibição do campo `canal` do lead.
//
// CANAIS (constants.js) é a lista de origens de marketing cadastradas
// manualmente pelo vendedor — valores em português, curados à mão. A
// integração automática do WhatsApp (migrations 016/017/019,
// process_inbound_whatsapp_event) grava um valor técnico diferente,
// minúsculo ('whatsapp'), que nunca esteve nessa lista.
//
// Bug corrigido aqui: o <select> de canal em LeadModal usava
// CANAIS.map(...) como única fonte de <option>s. Quando lead.canal não
// casa com NENHUMA option (ex. 'whatsapp'), o próprio elemento <select>
// HTML cai visualmente para a primeira option ('Facebook Marketplace')
// — nunca porque o valor foi de fato convertido (o estado React
// continuava guardando o valor real), mas a UI mostrava um rótulo
// errado, e qualquer interação com o dropdown (teclado, clique) podia
// commitar esse valor errado ao salvar.
//
// Correção: CANAL_LABELS mapeia valores técnicos conhecidos (hoje só
// 'whatsapp') para um rótulo de exibição correto; getCanalOptions()
// SEMPRE garante que o valor atual do lead apareça como uma option
// selecionável — usando o rótulo mapeado quando conhecido, ou o
// próprio valor bruto quando desconhecido (NUNCA convertido
// silenciosamente para a primeira opção da lista).
//
// Função pura, zero import de React/Supabase — mesmo padrão de
// src/lib/phoneIdentity.js.

export const CANAL_LABELS = {
  whatsapp: 'WhatsApp',
};

export function canalLabel(value) {
  if (!value) return value;
  return CANAL_LABELS[value] || value;
}

// `canais`: a lista oficial (CANAIS de constants.js), ordem preservada.
// `currentCanal`: lead.canal do lead sendo editado (ou null/undefined
// para um lead novo). Retorna [{value, label}] — canais primeiro,
// seguido do valor atual SE ele não estiver entre `canais` (nunca
// duplicado, nunca descartado silenciosamente).
export function getCanalOptions(canais, currentCanal) {
  const options = canais.map((c) => ({ value: c, label: c }));
  if (currentCanal && !canais.includes(currentCanal)) {
    options.push({ value: currentCanal, label: canalLabel(currentCanal) });
  }
  return options;
}
