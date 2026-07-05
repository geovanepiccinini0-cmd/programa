import { moneyFormat, moneyRaw } from '../utils.js';

export default function MoneyInput({ id, label, value, onChange }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input
        type="text"
        inputMode="numeric"
        className="money-input"
        id={id}
        placeholder="0,00"
        value={value}
        onFocus={(e) => onChange(moneyRaw(e.target.value))}
        onBlur={(e) => onChange(moneyFormat(e.target.value))}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
