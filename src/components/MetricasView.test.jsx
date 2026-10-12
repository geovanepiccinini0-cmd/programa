import { describe, expect, it } from 'vitest';
import { buildCommercialDashboard } from './MetricasView.jsx';

const lead = (id, overrides = {}) => ({
  id, userId: 'owner-1', etapa: 'Novo Lead', produto: 'Consórcio',
  canal: 'Indicação', credito: 100000, createdAt: '2026-10-10T12:00:00Z',
  ...overrides,
});
const now = new Date('2026-10-12T12:00:00Z');

describe('buildCommercialDashboard', () => {
  it('inclui os leads de todos os responsáveis, inclusive administrador, sem duplicar valores', () => {
    const data = buildCommercialDashboard([
      lead('1'), lead('2', { userId: 'admin', etapa: 'Ganho' }),
      lead('3', { userId: 'owner-2', etapa: 'Perdido' }),
      lead('4', { userId: 'owner-2', credito: 50000 }),
    ], { now });
    expect(data.total).toBe(4);
    expect(data.open).toBe(2);
    expect(data.won).toBe(1);
    expect(data.lost).toBe(1);
    expect(data.pipeline).toBe(150000);
    expect(data.currentWonRate).toBe(.25);
    expect(data.byOwner).toHaveLength(3);
  });

  it('filtra pela data de cadastro, não pela data de fechamento, e exclui removidos', () => {
    const data = buildCommercialDashboard([
      lead('recent'),
      lead('old', { createdAt: '2026-09-01T12:00:00Z', wonAt: '2026-10-11T12:00:00Z', etapa: 'Ganho' }),
      lead('removed', { deletedAt: '2026-10-11T12:00:00Z' }),
    ], { period: '7', now });
    expect(data.total).toBe(1);
    expect(data.won).toBe(0);
  });

  it('combina filtros de produto e responsável e respeita o valor por produto', () => {
    const data = buildCommercialDashboard([
      lead('1'),
      lead('2', { userId: 'owner-2', produto: 'Imóvel', valor: 350000, credito: 900000 }),
      lead('3', { userId: 'owner-2', produto: 'Consórcio' }),
    ], { product: 'Imóvel', owner: 'owner-2', now });
    expect(data.total).toBe(1);
    expect(data.pipeline).toBe(350000);
    expect(data.byProduct[0].name).toBe('Imóvel');
  });

  it('retorna zero em filtros sem resultados', () => {
    const data = buildCommercialDashboard([lead('1')], { product: 'Financiamento', now });
    expect(data.total).toBe(0);
    expect(data.pipeline).toBe(0);
    expect(data.currentWonRate).toBe(0);
    expect(data.byStage.every((stage) => stage.count === 0)).toBe(true);
  });
});
