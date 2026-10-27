import { describe, expect, it } from 'vitest';
import { buildAcquisitionTrend, buildCommercialDashboard, dashboardCSV } from './commercialDashboard.js';

const now = new Date('2026-10-27T15:00:00Z');
describe('captação e relatórios comerciais', () => {
  it('inclui intervalos sem cadastros e mantém a soma dos registros válidos', () => {
    const result = buildAcquisitionTrend([
      { createdAt: '2026-10-21T15:00:00Z' }, { createdAt: '2026-10-27T10:00:00Z' },
      { createdAt: 'inválida' }, {}, { createdAt: '2026-11-01T15:00:00Z' },
    ], { now, cutoff: new Date(2026, 9, 21) });
    expect(result.bins).toHaveLength(7);
    expect(result.bins.map((bin) => bin.count)).toEqual([1, 0, 0, 0, 0, 0, 1]);
    expect(result.undated).toBe(3);
  });
  it('não inventa uma série quando os registros não têm data', () => {
    expect(buildAcquisitionTrend([{}, { createdAt: 'inválida' }], { now })).toEqual({ bins: [], undated: 2 });
  });
  it('aplica os mesmos filtros aos gráficos, totais e motivos de perda', () => {
    const data = buildCommercialDashboard([
      { userId: 'a', produto: 'Consórcio', etapa: 'Perdido', canal: '__proto__', createdAt: '2026-10-26T12:00:00Z', lostReason: 'adiou_decisao' },
      { userId: 'a', produto: 'Consórcio', etapa: 'Perdido', createdAt: '2026-10-25T12:00:00Z' },
      { userId: 'b', produto: 'Imóvel', etapa: 'Ganho', createdAt: '2026-10-26T12:00:00Z' },
      { userId: 'a', produto: 'Consórcio', etapa: 'Perdido', createdAt: '2026-01-01T12:00:00Z', lostReason: 'sem_condicao' },
      { userId: 'a', produto: 'Consórcio', etapa: 'Perdido', deletedAt: '2026-10-26', createdAt: '2026-10-26T12:00:00Z' },
    ], { period: '7', product: 'Consórcio', owner: 'a', now });
    expect(data.total).toBe(2);
    expect(data.acquisition.bins.reduce((sum, bin) => sum + bin.count, 0)).toBe(2);
    expect(data.byLostReason).toEqual([{ name: 'Adiou decisão', count: 1 }, { name: 'Não informado', count: 1 }]);
    expect(data.byChannel.find((row) => row.name === '__proto__').count).toBe(1);
  });
  it('exporta os critérios, preserva acentos e neutraliza fórmulas de planilha', () => {
    const csv = dashboardCSV([{ name: '=HYPERLINK("malicious")', count: 3, won: 1, lost: 1, pipeline: 1234.5 }], {
      category: 'Origem', period: 'Últimos 30 dias', product: 'Todos', owner: 'Toda a equipe', asOf: now,
    });
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('Últimos 30 dias');
    expect(csv).toContain('"\'=HYPERLINK(""malicious"")"');
    expect(csv).toContain('"1234,50"');
    expect(csv).toContain('não receita ou comissão');
  });
});
