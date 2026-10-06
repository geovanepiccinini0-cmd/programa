// Fase 2D.1 — camada de ação assistida do Shadow Mode. Pura: sem React,
// sem Supabase, sem efeitos colaterais. Só decide/constrói o que a UI
// precisa para abrir uma ligação — nunca decide o que fazer com o
// resultado (isso continua sendo registerCommercialInteraction, via
// useCommercialRegistration). Abrir `tel:` e registrar um resultado
// comercial são deliberadamente coisas diferentes — ver
// useCommercialRegistration.js e FollowUpQueue.jsx.

// Normalização mínima (só dígitos, sem validação de DDD/tamanho
// brasileiro — fora de escopo desta fase, ver investigação 2D.0).
// Nunca usa formatPhoneBR (que é para exibição/digitação, não para
// construir um href). null quando não sobra nenhum dígito utilizável.
export function buildTelHref(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return `tel:${digits}`;
}
