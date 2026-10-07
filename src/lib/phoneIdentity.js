// Fase 3.1.1 — Pure Phone Identity. Fonte canônica única da normalização
// de telefone para fins de identidade. Extraída de normalizeWhatsAppPhone
// (followUpAction.js, Fase 2D.2.A) sem alterar nenhuma regra — só muda
// de módulo. followUpAction.js passa a depender deste módulo (nunca o
// contrário): zero import de React, Supabase, UI, window, document,
// navigator, Date.now, rede ou storage aqui. Determinística: o
// resultado depende só do argumento recebido, nunca muta o input.
//
// Formato canônico de saída (quando VALID): dígitos puros, com DDI 55,
// sem "+". Ex.: 5551992322166 — o mesmo formato já usado por
// buildWhatsAppHref (wa.me/<number>), sem nenhuma conversão extra.
//
// Política V1 (idêntica à já homologada em 2D.2.A, só realocada):
// - Suporta SOMENTE números brasileiros reconhecíveis com segurança.
// - Números internacionais não-BR (+1, +351, +54, ...) NUNCA são
//   normalizados nem recebem DDI 55 — são sempre AMBIGUOUS.
// - DDD nunca é inventado/corrigido/adivinhado; nono dígito nunca é
//   adicionado/removido.
// - DDD é só validado estruturalmente (2 dígitos na posição esperada
//   dentro de um comprimento reconhecido) — nenhuma tabela de DDDs
//   válidos é criada.

export const PHONE_IDENTITY_STATUS = {
  VALID: 'valid',
  INVALID: 'invalid',
  AMBIGUOUS: 'ambiguous',
};

function invalid() {
  return { status: PHONE_IDENTITY_STATUS.INVALID, number: null };
}

function ambiguous() {
  return { status: PHONE_IDENTITY_STATUS.AMBIGUOUS, number: null };
}

function valid(number) {
  return { status: PHONE_IDENTITY_STATUS.VALID, number };
}

// Marcador de ramal/extensão — guardrail crítico: remover só os
// não-dígitos de "(51) 3333-4444 ramal 123" produziria "513333444123",
// misturando o ramal no número. Em vez de tentar separar/corrigir,
// qualquer marcador textual reconhecido vira AMBIGUOUS antes mesmo de
// olhar para os dígitos.
const RAMAL_PATTERN = /\bramal\b|\br\.?\s*\d+\b|\bext\.?\s*\d+\b/i;

// BR sem DDI: DDD (2 dígitos) + número de 8 (fixo) ou 9 (celular, com
// nono dígito) dígitos — nunca inventa/corrige o nono dígito, só aceita
// os dois comprimentos estruturais como estão.
const BR_LOCAL_LENGTHS = new Set([10, 11]);

export function normalizePhoneIdentity(phone) {
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
  // literal, nunca uma regra genérica para qualquer "00" inicial.
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
