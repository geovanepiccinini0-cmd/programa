# CRM Piccinini · Conseg Invest

Sistema de CRM (Hoje / Funil / Rotina) para gestão de leads de Consórcio, Carta Contemplada, Home Equity e Imóvel — convertido do protótipo HTML original para uma aplicação **React + Vite** com backend em **Supabase** (banco de dados Postgres + autenticação), sincronizando os dados entre qualquer navegador/dispositivo.

## Requisitos

- Node.js 18 ou superior
- npm
- Uma conta grátis no [Supabase](https://supabase.com)

## 1. Criar o backend no Supabase

1. Crie uma conta em [supabase.com](https://supabase.com) e clique em **New project**.
2. Espere o projeto ser provisionado (1-2 minutos).
3. Vá em **SQL Editor** → **New query**, cole todo o conteúdo do arquivo [`supabase/schema.sql`](./supabase/schema.sql) deste projeto e clique em **Run**. Isso cria as tabelas `leads`, `tasks` e `templates`, com as regras de segurança (cada usuário só vê os próprios dados).
4. Vá em **Authentication → Users → Add user** e crie o seu usuário (e-mail e senha) — é o login que você vai usar no sistema. Não é necessário criar um formulário de cadastro: como é uso pessoal, o usuário é criado direto pelo painel do Supabase.
5. Vá em **Project Settings → API** e copie:
   - **Project URL**
   - **anon public key**

## 2. Configurar o projeto localmente

```bash
npm install
```

A URL e a anon/publishable key do Supabase já estão embutidas em `src/lib/supabaseClient.js` como valores padrão — essa chave é feita para ser pública (a proteção real dos dados é a Row Level Security do banco), então não é obrigatório usar variáveis de ambiente. Se quiser apontar para outro projeto Supabase (ex.: um ambiente de testes), copie `.env.example` para `.env` e preencha `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` — esses valores, se definidos, têm prioridade sobre os padrões do código.

## 3. Executar em desenvolvimento

```bash
npm run dev
```

Abra `http://localhost:5173`, faça login com o e-mail/senha criados no passo 1.4.

## 4. Gerar build de produção

```bash
npm run build
```

Os arquivos otimizados são gerados em `dist/`. Para pré-visualizar o build:

```bash
npm run preview
```

## 5. Publicar online (Vercel/Netlify)

1. Suba o repositório no GitHub (já está feito, se você está lendo isso a partir dele).
2. Crie o projeto na [Vercel](https://vercel.com) ou [Netlify](https://netlify.com) importando este repositório.
3. Deploy — não é necessário configurar nenhuma variável de ambiente, já que os valores padrão do Supabase estão embutidos no código. Você recebe um link acessível de qualquer dispositivo, com login protegido e dados sincronizados em tempo real entre eles.

## Persistência e sincronização

Os dados (leads, tarefas e rotinas) ficam salvos no banco Postgres do seu projeto Supabase, não mais no navegador. Isso significa:

- Acesso de qualquer dispositivo com o mesmo login.
- Mudanças feitas em um dispositivo aparecem automaticamente nos outros (sincronização em tempo real via Supabase Realtime), sem precisar recarregar a página.
- Os botões **⬇ Backup** e **⬆ Importar** no cabeçalho continuam disponíveis para exportar/restaurar tudo em um arquivo `.json`, e **📊 Planilha** para exportar leads filtrados em CSV.

## Estrutura do projeto

```
supabase/
  schema.sql              Tabelas, políticas de segurança (RLS) e realtime do backend
src/
  constants.js            Listas fixas (etapas do funil, produtos, canais, categorias)
  utils.js                 Formatação, datas, cálculo de valores, exportação CSV/JSON
  lib/
    supabaseClient.js       Cliente Supabase (lê VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY)
    db.js                   Mapeamento de dados e funções de CRUD por tabela
  hooks/
    useAuth.js              Sessão de login (signIn/signOut) via Supabase Auth
    useAppState.js          Estado central (leads/tasks/templates), sync com o backend e geração automática de tarefas
  components/
    Login.jsx               Tela de login (e-mail/senha)
    Header.jsx               Cabeçalho, abas e ações (novo lead, backup, importar, planilha, sair)
    StatsBar.jsx              Cartões de estatísticas do topo
    HojeView.jsx              Lista de tarefas do dia, agrupadas por categoria
    FunilView.jsx              Funil (Kanban) com filtros por produto e "parados"
    HealthBar.jsx              Barra de distribuição do pipeline por produto
    Kanban.jsx                  Colunas do funil e cartões de lead
    RotinaView.jsx             Cadastro de tarefas recorrentes por dia da semana
    LeadModal.jsx              Modal de criação/edição de lead
    ProdutoFields.jsx          Campos específicos por produto (crédito, entrada, LTV, etc.)
    MoneyInput.jsx             Input monetário com máscara em R$
    ExportModal.jsx            Modal de exportação de leads para CSV
  App.jsx                   Gate de autenticação + orquestração das views e modais
  main.jsx                  Ponto de entrada React
```

## Empacotar como aplicativo desktop (opcional)

Caso queira um executável (Windows/Mac/Linux) em vez de uma aplicação web, é possível empacotar este mesmo projeto React com [Tauri](https://tauri.app) (mais leve) ou [Electron](https://www.electronjs.org). Peça para gerar essa camada quando precisar — não está incluída neste código para manter o projeto simples.
