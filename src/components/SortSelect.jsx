export default function SortSelect({ value, onChange }) {
  return (
    <label style={{ fontSize: 12.5, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
      Ordenar por
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="padrao">Padrão (parados primeiro)</option>
        <option value="novo">Mais novos primeiro</option>
        <option value="antigo">Mais antigos primeiro</option>
      </select>
    </label>
  );
}
