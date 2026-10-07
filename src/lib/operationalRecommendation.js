// Fase 2E.5.1A — seletor operacional puro. Decide qual das duas
// recomendações já calculadas (NBA atual vs. candidate da Commercial
// Policy V1) deve ser considerada "a" recomendação operacional nesta
// execução — e SÓ isso. Não busca dado, não calcula history, não
// calcula policy, não valida telefone, não renderiza texto, não
// registra interaction. Zero React, zero Supabase, zero Date.now,
// zero Math.random. Determinístico, O(1): nenhum loop/sort/query.
//
// Esta fase NÃO ativa a Commercial Policy — o módulo só existe para
// ser testado isoladamente. Nenhum consumidor de produção o importa
// ainda (ver relatório da subfase).

// Fase 2E.5.1A — dois modos explícitos, nunca um boolean obscuro (ver
// investigação 2E.5.0, seção 20). Strings estáveis, não enum numérico,
// para ficarem autoexplicativas em qualquer log/teste/depuração futura.
export const OPERATIONAL_RECOMMENDATION_SOURCE = {
  CURRENT: 'current',
  COMMERCIAL_POLICY: 'commercial_policy',
};

// Fase 2E.5.1A — única função desta camada.
//
// source === CURRENT: devolve `current` exatamente como recebido,
// inclusive null — reproduz 100% o comportamento operacional de hoje.
//
// source === COMMERCIAL_POLICY: devolve `candidate` exatamente como
// recebido, inclusive null. REGRA CRÍTICA (investigação 2E.5.0, seção
// 17-B): candidate null NUNCA cai para `current` — isso reintroduziria
// exatamente os comportamentos que a Commercial Policy V1 corrigiu de
// propósito (Proposal Leak, fallthrough de follow_up/other). Um
// candidate null significa "sem recomendação", não "use a antiga".
//
// Qualquer `source` que não seja um dos dois valores conhecidos
// (ausente, string desconhecida, valor malformado) é tratado como
// inválido e devolve null — nunca current automático. Uma configuração
// quebrada não deve reativar silenciosamente o comportamento legado
// (investigação 2E.5.0, seção 8): o fail-safe de uma fonte inválida é
// "sem recomendação visível", não "volta pro de antes" — isso torna o
// erro de configuração observável (o vendedor veria a recomendação
// desaparecer, não uma recomendação errada aparecendo).
//
// Nunca muta `current`/`candidate` — quando devolve um objeto, é
// sempre a MESMA referência recebida (nunca clonada/renormalizada).
export function selectOperationalRecommendation({ source, current, candidate }) {
  if (source === OPERATIONAL_RECOMMENDATION_SOURCE.CURRENT) return current;
  if (source === OPERATIONAL_RECOMMENDATION_SOURCE.COMMERCIAL_POLICY) return candidate;
  return null;
}
