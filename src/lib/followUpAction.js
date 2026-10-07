// Fase 2D.1 — camada de ação assistida do Shadow Mode. Pura: sem React,
// sem Supabase, sem efeitos colaterais. Só decide/constrói o que a UI
// precisa para abrir uma ligação ou uma conversa de WhatsApp — nunca
// decide o que fazer com o resultado (isso continua sendo
// registerCommercialInteraction, via useCommercialRegistration). Abrir
// `tel:`/wa.me e registrar um resultado comercial são deliberadamente
// coisas diferentes — ver useCommercialRegistration.js e
// FollowUpQueue.jsx.

import { normalizePhoneIdentity, PHONE_IDENTITY_STATUS } from './phoneIdentity.js';

// Normalização mínima (só dígitos, sem validação de DDD/tamanho
// brasileiro — fora de escopo desta fase, ver investigação 2D.0).
// Nunca usa formatPhoneBR (que é para exibição/digitação, não para
// construir um href). null quando não sobra nenhum dígito utilizável.
// Deliberadamente permissivo: o discador do sistema tolera/corrige
// qualquer formato — diferente de buildWhatsAppHref abaixo, que exige
// DDI explícito e por isso precisa de uma normalização muito mais
// rígida (ver investigação 2D.2.0).
export function buildTelHref(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (!digits) return null;
  return `tel:${digits}`;
}

// Fase 2D.2.A — normalização segura de telefone para WhatsApp (wa.me).
//
// Diferente de buildTelHref (que só remove não-dígitos e deixa o
// discador lidar com o resto), wa.me exige DDI completo e explícito —
// um DDI ausente/duplicado, ou dígitos de ramal misturados ao número,
// abrem a conversa com a pessoa ERRADA, silenciosamente, sem erro.
// Por isso esta normalização é deliberadamente rígida e conservadora:
// na dúvida, NUNCA gera link (ver AMBIGUOUS abaixo) — investigação
// completa em 2D.2.0 (riscos, casos obrigatórios, política de DDI).
//
// Fase 3.1.1 — a regra em si (o que é VALID/INVALID/AMBIGUOUS) foi
// extraída para src/lib/phoneIdentity.js, módulo neutro de domínio
// (zero React/Supabase/UI) reaproveitável pela futura Identity
// Foundation (Fase 3.1+). Esta função é agora um re-export direto —
// UMA fonte de verdade só, nunca duas implementações independentes.
// WHATSAPP_PHONE_STATUS continua exportado daqui (mesmos valores de
// string de PHONE_IDENTITY_STATUS) para não quebrar nenhum consumidor
// existente desta API pública.
export const WHATSAPP_PHONE_STATUS = PHONE_IDENTITY_STATUS;
export const normalizeWhatsAppPhone = normalizePhoneIdentity;

// Só gera URL quando normalizeWhatsAppPhone devolve VALID — qualquer
// AMBIGUOUS/INVALID vira null aqui, nunca uma tentativa de "melhor
// esforço". Fase 2D.2.A: sem ?text= (sem mensagem pré-preenchida nesta
// V1, ver investigação 2D.2.0 — deixado para uma fase futura, se algum
// dia for decidido).
export function buildWhatsAppHref(phone) {
  const result = normalizeWhatsAppPhone(phone);
  if (result.status !== WHATSAPP_PHONE_STATUS.VALID) return null;
  return `https://wa.me/${result.number}`;
}
