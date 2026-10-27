import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LeadCardBody } from './LeadCardInfo.jsx';

const base = { nome: 'Cliente Exemplo', telefone: '(51) 90000-0000', cidade: 'Porto Alegre', canal: 'Indicação', tipo: 'Imobiliário', etapa: 'Proposta', tags: ['PRIORIDADE'], credito: 300000, valor: 200000, entrada: 90000, parcela: 1500, lance: 60000, valorImovel: 400000, proximoContato: '2026-11-02', proximoContatoHorario: '14:30', ultimaAtualizacao: '2026-10-01' };
describe('cartão completo do lead', () => {
  it.each([
    ['Consórcio', ['Parcela', 'Lance', '60.000']],
    ['Carta Contemplada', ['Entrada', 'Parcela', '30% do crédito']],
    ['Home Equity', ['Imóvel avaliado em', '400.000', 'LTV', '50%']],
    ['Financiamento', ['Entrada', 'Parcela', '90.000']],
    ['Imóvel', ['200.000']],
  ])('preserva condições e contexto para %s', (produto, details) => {
    const html = renderToStaticMarkup(<LeadCardBody lead={{ ...base, produto }} footer={<button>Editar</button>}/>);
    for (const text of ['Cliente Exemplo', '(51) 90000-0000', 'Porto Alegre', 'Indicação', 'Imobiliário', 'PRIORIDADE', 'Próximo contato', '14:30', 'Editar', ...details]) expect(html).toContain(text);
    expect(html).toContain('Sem atualização de cadastro há');
  });
  it('preserva o alerta de lead ativo sem próxima ação', () => {
    expect(renderToStaticMarkup(<LeadCardBody lead={{ ...base, produto: 'Consórcio', proximoContato: '' }}/>)).toContain('SEM PRÓXIMA AÇÃO');
    expect(renderToStaticMarkup(<LeadCardBody lead={{ ...base, produto: 'Consórcio', etapa: 'Ganho', proximoContato: '' }}/>)).not.toContain('SEM PRÓXIMA AÇÃO');
  });
});
