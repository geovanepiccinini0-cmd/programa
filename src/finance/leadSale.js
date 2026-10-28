const missing = value => value == null || value === '';
const leadAmount = value => {
  if (missing(value)) return null;
  const amount = Math.round(Number(value) * 100);
  return Number.isSafeInteger(amount) && amount >= 0 && amount <= 1e12 ? amount : null;
};

// Import only missing information into pending sales. Never overwrite negotiated
// sale values or historical conditions, and never create a cash receipt.
export function fillSaleFromLead(sale, lead) {
  if (!lead || sale.leadId !== lead.id || sale.status !== 'draft' || sale.product !== 'Carta Contemplada') return sale;
  return {
    ...sale,
    ...(missing(sale.saleValue) ? { saleValue: leadAmount(lead.entrada) } : {}),
    ...(missing(sale.quotaInstallment) ? { quotaInstallment: leadAmount(lead.parcela) } : {}),
  };
}
