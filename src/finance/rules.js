// Confirmed sales retain their immutable rule snapshot and installment schedule.
export function deleteCommissionRule(state, ruleId) {
  if (!state.rules.some(rule => rule.id === ruleId)) throw new Error('Regra não encontrada. Recarregue os dados.');
  return {
    ...state,
    rules: state.rules.filter(rule => rule.id !== ruleId),
    sales: state.sales.map(sale => sale.status === 'draft' && sale.ruleId === ruleId ? { ...sale, ruleId: '' } : sale),
  };
}
