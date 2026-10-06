// Fase 2D.1 — camada de ação assistida do Shadow Mode. Pura: sem React,
// sem Supabase, sem efeitos colaterais. Só decide/constrói o que a UI
// precisa para abrir uma ligação ou uma conversa de WhatsApp — nunca
// decide o que fazer com o resultado (isso continua sendo
// registerCommercialInteraction, via useCommercialRegistration). Abrir
// `tel:`/wa.me e registrar um resultado comercial são deliberadamente
// coisas diferentes — ver useCommercialRegistration.js e
// FollowUpQueue.jsx.

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

// Fase 2D.2.A — normalização seguro de telefone para WhatsApp (wa.me).
//
// Diferente de buildTelHref (que só remove não-dígitos e deixa o
// discador lidar com o resto), wa.me exige DDI completo e explícito —
// um DDI ausente/duplicado, ou dígitos de ramal misturados ao número,
// abrem a conversa com a pessoa ERRADA, silenciosamente, sem erro.
// Por isso esta normalização é deliberadamente rígida e conservadora:
// na dúvida, NUNCA gera link (ver AMBIGUOUS abaixo) — investigação
// completa em 2D.2.0 (riscos, casos obrigatórios, política de DDI).
//
// Política V1 (deliberadamente mais estreita que a alternativa
// internacional discutida na investigação):
// - Suporta SOMENTE números brasileiros reconhecíveis com segurança.
// - Números internacionais não-BR (+1, +351, +54, ...) NUNCA são
//   normalizados nem recebem DDI 55 — são sempre AMBIGUOUS.
// - DDD nunca é inventado/corrigido/adivinhado; nono dígito nunca é
//   adicionado/removido — a existência real do número é
//   responsabilidade do WhatsApp, não desta função.
// - DDD é só validado estruturalmente (2 dígitos na posição esperada
//   dentro de um comprimento reconhecido) — nenhuma tabela de DDDs
//   válidos é criada nesta fase, de propósito.
export const WHATSAPP_PHONE_STATUS = {
  VALID: 'valid',
  INVALID: 'invalid',
  AMBIGUOUS: 'ambiguous',
};

function invalid() {
  return { status: WHATSAPP_PHONE_STATUS.INVALID, number: null };
}

function ambiguous() {
  return { status: WHATSAPP_PHONE_STATUS.AMBIGUOUS, number: null };
}

function valid(number) {
  return { status: WHATSAPP_PHONE_STATUS.VALID, number };
}

// Marcador de ramal/extensão — guardrail crítico (ver 2D.2.0 seção 11):
// remover só os não-dígitos de "(51) 3333-4444 ramal 123" produziria
// "513333444123", misturando o ramal no número. Em vez de tentar
// separar/corrigir, qualquer marcador textual reconhecido vira
// AMBIGUOUS antes mesmo de olhar para os dígitos.
const RAMAL_PATTERN = /\bramal\b|\br\.?\s*\d+\b|\bext\.?\s*\d+\b/i;

// BR sem DDI: DDD (2 dígitos) + número de 8 (fixo) ou 9 (celular, com
// nono dígito) dígitos — nunca inventa/corrige o nono dígito, só aceita
// os dois comprimentos estruturais como estão.
const BR_LOCAL_LENGTHS = new Set([10, 11]);

export function normalizeWhatsAppPhone(phone) {
  if (phone === null || phone === undefined) return invalid();
  const raw = String(phone).trim();
  if (!raw) return invalid();

  if (RAMAL_PATTERN.test(raw)) return ambiguous();

  // O sinal "+" precisa ser interpretado ANTES de qualquer remoção
  // genérica de caracteres — depois de stripar, a informação "este
  // número já veio com DDI explícito, e qual" se perde.
  if (raw.startsWith('+')) {
    if (!raw.startsWith('+55')) return ambiguous(); // internacional não-BR: nunca prefixa 55, nunca adivinha DDI
    const digits = raw.replace(/\D/g, '');
    return normalizeBrazilianDigits(digits);
  }

  const digits = raw.replace(/\D/g, '');
  if (!digits) return invalid();

  // "0055" explícito (prefixo de saída internacional) — só este caso
  // literal, nunca uma regra genérica para qualquer "00" inicial (um
  // "0" + código de operadora é uma convenção legada de discagem local
  // brasileira, ambígua demais para tratar como DDI sem o "55" logo
  // depois confirmando a intenção).
  const withoutExitPrefix = digits.startsWith('0055') ? digits.slice(2) : digits;

  return normalizeBrazilianDigits(withoutExitPrefix);
}

// Recebe só dígitos (sem "+", sem "00" de saída já tratado). Decide
// entre "já tem DDI 55" (12/13 dígitos começando com 55) e "sem DDI"
// (10/11 dígitos — aí sim prefixa 55, uma única vez). Qualquer outro
// comprimento é AMBIGUOUS — nunca adivinha, nunca força.
function normalizeBrazilianDigits(digits) {
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    return valid(digits);
  }
  if (BR_LOCAL_LENGTHS.has(digits.length)) {
    return valid(`55${digits}`);
  }
  return ambiguous();
}

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
