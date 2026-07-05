import MoneyInput from './MoneyInput.jsx';

export default function ProdutoFields({ produto, extra, onExtraChange }) {
  const set = (key) => (value) => onExtraChange({ ...extra, [key]: value });

  if (produto === 'Carta Contemplada') {
    return (
      <>
        <div className="field-row">
          <div className="field">
            <label htmlFor="f-tipo">Tipo</label>
            <select id="f-tipo" value={extra.tipo || 'Veículo'} onChange={(e) => set('tipo')(e.target.value)}>
              <option value="Veículo">Veículo</option>
              <option value="Imóvel">Imóvel</option>
            </select>
          </div>
          <MoneyInput id="f-credito" label="Crédito (R$)" value={extra.credito ?? ''} onChange={set('credito')} />
        </div>
        <div className="field-row">
          <MoneyInput id="f-entrada" label="Entrada (R$)" value={extra.entrada ?? ''} onChange={set('entrada')} />
          <MoneyInput id="f-parcela" label="Parcela (R$)" value={extra.parcela ?? ''} onChange={set('parcela')} />
        </div>
      </>
    );
  }

  if (produto === 'Consórcio') {
    return (
      <>
        <div className="field-row">
          <div className="field">
            <label htmlFor="f-tipo">Tipo</label>
            <select id="f-tipo" value={extra.tipo || 'Imóvel'} onChange={(e) => set('tipo')(e.target.value)}>
              <option value="Imóvel">Imóvel</option>
              <option value="Veículo">Veículo</option>
              <option value="Investimento">Investimento</option>
            </select>
          </div>
          <MoneyInput id="f-credito" label="Valor de crédito (R$)" value={extra.credito ?? ''} onChange={set('credito')} />
        </div>
        <div className="field-row">
          <MoneyInput id="f-parcela" label="Valor mensal de investimento (R$)" value={extra.parcela ?? ''} onChange={set('parcela')} />
          <MoneyInput id="f-lance" label="Valor de lance (R$)" value={extra.lance ?? ''} onChange={set('lance')} />
        </div>
      </>
    );
  }

  if (produto === 'Home Equity') {
    return (
      <div className="field-row">
        <MoneyInput id="f-valorimovel" label="Valor de avaliação do imóvel (R$)" value={extra.valorImovel ?? ''} onChange={set('valorImovel')} />
        <MoneyInput id="f-valor" label="Valor estimado a ser tomado (R$)" value={extra.valor ?? ''} onChange={set('valor')} />
      </div>
    );
  }

  return (
    <div className="field-row">
      <MoneyInput id="f-valor" label="Valor estimado (R$)" value={extra.valor ?? ''} onChange={set('valor')} />
    </div>
  );
}
