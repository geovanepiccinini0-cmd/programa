export const ruleCoversSaleDate = (rule, soldAt) => !!rule && soldAt >= rule.startsOn && (!rule.endsOn || soldAt <= rule.endsOn);
export const canConfirmHistoricalRule = (rule, soldAt, today) => !!rule && /^\d{4}-\d{2}-\d{2}$/.test(soldAt || '') && soldAt < rule.startsOn && rule.startsOn <= today;
export const historicalRuleConfirmation = (rule, soldAt) => ({ confirmed: true, ruleId: rule.id, soldAt, startsOn: rule.startsOn });
export const hasHistoricalRuleConfirmation = (sale, rule) => {
  const confirmation = sale.historicalRuleConfirmation;
  return !!rule && confirmation?.confirmed === true && confirmation.ruleId === rule.id && confirmation.soldAt === sale.soldAt && confirmation.startsOn === rule.startsOn;
};
