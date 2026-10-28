// Shared by commission settings and sales. Preserve existing category names.
export const CONSORTIUM_CATEGORIES = ['Imóveis', 'Automóveis', 'Pesados', 'Serviços', 'Outros bens'];
export const categoryOptions = (existing = []) => [...new Set([...CONSORTIUM_CATEGORIES, ...existing.filter(Boolean)])];
