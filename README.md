# CRM Piccinini · Conseg Invest

Sistema de CRM (Hoje / Funil / Rotina) para gestão de leads de Consórcio, Carta Contemplada, Home Equity e Imóvel — convertido do protótipo HTML original para uma aplicação **React + Vite** estruturada em componentes.

## Requisitos

- Node.js 18 ou superior
- npm

## Instalação

```bash
npm install
```

## Executar em desenvolvimento

```bash
npm run dev
```

Abra `http://localhost:5173` no navegador.

## Gerar build de produção

```bash
npm run build
```

Os arquivos otimizados são gerados em `dist/`. Para pré-visualizar o build:

```bash
npm run preview
```

O conteúdo de `dist/` pode ser hospedado em qualquer servidor estático (Netlify, Vercel, GitHub Pages, Nginx, etc.) ou aberto localmente.

## Persistência de dados

Os dados (leads, tarefas e rotinas) são salvos automaticamente no `localStorage` do navegador — não é necessário backend nem banco de dados. Use os botões **⬇ Backup** e **⬆ Importar** no cabeçalho para exportar/restaurar os dados em arquivo `.json`, e **📊 Planilha** para exportar leads filtrados em CSV.

## Estrutura do projeto

```
src/
  constants.js          Listas fixas (etapas do funil, produtos, canais, categorias)
  utils.js               Formatação, datas, cálculo de valores, exportação CSV/JSON
  hooks/
    useAppState.js        Estado central (leads/tasks/templates) + persistência + geração automática de tarefas
  components/
    Header.jsx            Cabeçalho, abas e ações (novo lead, backup, importar, planilha)
    StatsBar.jsx           Cartões de estatísticas do topo
    HojeView.jsx           Lista de tarefas do dia, agrupadas por categoria
    FunilView.jsx          Funil (Kanban) com filtros por produto e "parados"
    HealthBar.jsx          Barra de distribuição do pipeline por produto
    Kanban.jsx              Colunas do funil e cartões de lead
    RotinaView.jsx         Cadastro de tarefas recorrentes por dia da semana
    LeadModal.jsx          Modal de criação/edição de lead
    ProdutoFields.jsx      Campos específicos por produto (crédito, entrada, LTV, etc.)
    MoneyInput.jsx         Input monetário com máscara em R$
    ExportModal.jsx        Modal de exportação de leads para CSV
  App.jsx                 Orquestração das views e modais
  main.jsx                Ponto de entrada React
```

## Empacotar como aplicativo desktop (opcional)

Caso queira um executável (Windows/Mac/Linux) em vez de uma aplicação web, é possível empacotar este mesmo projeto React com [Tauri](https://tauri.app) (mais leve) ou [Electron](https://www.electronjs.org). Peça para gerar essa camada quando precisar — não está incluída neste código para manter o projeto simples.
