import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ProductInsights, { productRingPath } from './ProductInsights.jsx';

describe('exploração de interesse por produto', () => {
  it('mostra quantidade, participação e seleção acessível para a distribuição real', () => {
    const rows = [
      { name: 'Carta Contemplada', count: 114, won: 10, lost: 4, pipeline: 1000000 },
      { name: 'Consórcio', count: 29, won: 2, lost: 1, pipeline: 200000 },
      { name: 'A identificar', count: 6, won: 0, lost: 0, pipeline: 0 },
      { name: 'Financiamento', count: 2, won: 0, lost: 0, pipeline: 300000 },
      { name: 'Imóvel', count: 1, won: 0, lost: 0, pipeline: 400000 },
    ];
    const html = renderToStaticMarkup(<ProductInsights rows={rows} total={152} onFilter={() => {}} onReport={() => {}}/>);
    expect(html).toContain('114 leads, 75%');
    expect(html).toContain('29 leads, 19,1%');
    expect(html).toContain('152');
    expect(html.match(/role="button"/g)).toHaveLength(5);
    expect(html).not.toContain('NaN');
  });
  it('desenha um anel completo quando o filtro retorna um único produto', () => {
    const path = productRingPath(0, 360);
    expect(path.match(/ A/g)).toHaveLength(4);
    expect(path).not.toMatch(/NaN|Infinity/);
    const html = renderToStaticMarkup(<ProductInsights rows={[{ name: 'Consórcio', count: 1 }]} total={1}/>);
    expect(html).toContain('100%');
  });
  it('trata seleção sem resultados sem gerar divisões por zero', () => {
    const html = renderToStaticMarkup(<ProductInsights rows={[]} total={0}/>);
    expect(html).toContain('Nenhum lead para os filtros selecionados');
    expect(html).not.toContain('<svg');
  });
});
