import { PRODUTOS, STALE_DAYS } from '../constants.js';
import HealthBar from './HealthBar.jsx';
import Kanban from './Kanban.jsx';

export default function FunilView({ leads, filterProduto, setFilterProduto, filterStale, setFilterStale, onEdit, onDelete, onMoveStage }) {
  const opts = ['Todos', ...PRODUTOS];
  return (
    <section className="view active">
      <HealthBar leads={leads} />
      <div className="filters">
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
      </div>
      <Kanban
        leads={leads}
        filterProduto={filterProduto}
        filterStale={filterStale}
        onEdit={onEdit}
        onDelete={onDelete}
        onMoveStage={onMoveStage}
      />
    </section>
  );
}
