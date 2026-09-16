import { PRODUTOS, STALE_DAYS } from '../constants.js';
import HealthBar from './HealthBar.jsx';
import Kanban from './Kanban.jsx';
import SortSelect from './SortSelect.jsx';

export default function FunilView({ leads, filterProduto, setFilterProduto, filterStale, setFilterStale, sortOrder, setSortOrder, searchQuery, setSearchQuery, onEdit, onDelete, onMoveStage, onDropStage }) {
  const opts = ['Todos', ...PRODUTOS];
  return (
    <section className="view active">
      <HealthBar leads={leads} />
      <div className="filters" style={{ alignItems: 'center' }}>
        <label style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <span style={{ position: 'absolute', left: 10, pointerEvents: 'none', opacity: 0.6 }}>🔍</span>
          <input
            type="text"
            placeholder="Buscar por nome ou telefone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ paddingLeft: 30, minWidth: 220 }}
          />
          {searchQuery && (
            <button
              className="icon-btn"
              style={{ position: 'absolute', right: 4, padding: '2px 6px' }}
              onClick={() => setSearchQuery('')}
            >
              ✕
            </button>
          )}
        </label>
        {opts.map((p) => (
          <button
            key={p}
            className={`chip ${filterProduto === p ? 'active' : ''}`}
            onClick={() => setFilterProduto(p)}
          >
            {p}
          </button>
        ))}
        <button
          className={`chip ${filterStale ? 'active' : ''}`}
          style={{ borderColor: 'var(--red)', ...(filterStale ? { background: 'var(--red)', color: '#fff' } : {}) }}
          onClick={() => setFilterStale(!filterStale)}
        >
          🕒 Parados ({STALE_DAYS}+ dias)
        </button>
        <SortSelect value={sortOrder} onChange={setSortOrder} />
      </div>
      <Kanban
        leads={leads}
        filterProduto={filterProduto}
        filterStale={filterStale}
        sortOrder={sortOrder}
        searchQuery={searchQuery}
        onEdit={onEdit}
        onDelete={onDelete}
        onMoveStage={onMoveStage}
        onDropStage={onDropStage}
      />
    </section>
  );
}
