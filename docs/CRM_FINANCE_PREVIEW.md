# Vendas, Financeiro e Configurações — preview para aprovação

Esta branch implementa o fluxo comercial/financeiro solicitado por Geovane. Não deve ser mesclada nem publicada em produção antes da aprovação da preview. Nenhuma migração foi aplicada ao Supabase de produção.

## O que testar

- **Funil da preview:** mover o lead fictício para Ganho cria uma ficha pendente em Vendas. Voltar a Ganho não duplica a ficha. O funil e as automações de produção não foram reconfigurados.
- **Vendas:** salvar informações incompletas como pendentes; confirmar uma contemplada com venda menos custo e divisão 50/50 ou 60/40; conferir o demonstrativo mensal/CSV do escritório. Crédito da carta é separado do preço da operação.
- **Configurações:** cadastrar administradora, modalidade (Imobiliário/Veículos/Outros), plano (meia parcela/reduzida/integral), vigência, percentual sobre crédito, repasse e calendário ponderado. A distribuição das parcelas deve somar 100%. Nova regra é uma versão, sem recalcular vendas anteriores.
- **Consórcio:** escolher a combinação e regra vigente na venda. Sem regra, a venda fica pendente. Comissão própria e datas são congeladas na confirmação; o calendário admite valores e intervalos diferentes, com ajuste de centavos na última parcela.
- **Financeiro:** mapa de seis meses com linhas por venda e totais mensais; filtrar produto, alternar previsto/recebido da parcela/saldo, abrir células, exportar CSV; registrar recebimentos parciais e devoluções com histórico.
- **Caixinhas:** criar metas e percentuais de sugestão sobre os recebimentos próprios; confirmar a separação feita manualmente no banco ou o retorno ao caixa geral. Não há integração bancária. Reservar não é gastar e não reduz o caixa geral.
- **Despesas:** registrar obrigação, vincular canal, campanha, orçamento, caixinha e/ou venda; pagamento consome a caixinha e o caixa uma única vez.
- **Orçamento por canal:** planejar limite mensal e acompanhar comprometido/pago/saldo. Planejamento não executa anúncio nem consome caixa. A fase inicial é formar os caixas com receitas do orgânico.
- **Caixa planejado:** seis meses futuros, a partir do realizado; recebíveis/despesas vencidos ficam destacados sem presumir liquidação. Dados pendentes não entram como receita. Comissões previstas não liberam destinações.
- **Métricas:** fechamentos, crédito de consórcio e remuneração própria por canal; caixa pela data efetiva. Indicadores antigos de aquisição continuam disponíveis no CRM autenticado.

## Isolamento da preview

`CONTEXT=deploy-preview` compila a entrada para `FinancePreview`, sem montar o CRM autenticado. Dados são fictícios e persistidos em `localStorage` exclusivamente naquela origem/navegador. Não dependem de login e não acessam dados do Supabase. A importação do cliente Supabase só ocorre no caminho não-preview do repositório financeiro.

Na execução local, `?finance-preview` está disponível somente em `import.meta.env.DEV`. Em produção essa query não habilita a demonstração. O botão Restaurar exemplos apaga somente os testes da preview.

As regras e percentuais pré-carregados são didáticos. Não representam as condições reais de nenhuma administradora e não serão inicializados em produção.

## Persistência definitiva preparada

`20261028105435_commercial_finance_workspace.sql` foi criada pela CLI e testada em PostgreSQL embarcado (PGlite), sem executar contra o projeto real.

- Workspace JSONB único para os administradores do CRM, com versão otimista, limite de 10 MB e coleções identificadas. Trata-se de um agregado para o porte atual do CRM, sem promessa de concorrência/volume irrestritos. Expansão de equipe ou alto volume exigirá revisão para tabelas normalizadas e comandos por entidade.
- RLS em workspace e histórico, acesso somente para `is_admin()`. Sem escrita direta por `authenticated`; gravação via RPC com autorização no servidor, comparação de revisão, validação e auditoria.
- Funções privilegiadas internas em schema privado, `search_path` vazio e privilégios explícitos. O wrapper público é `SECURITY INVOKER`.
- Trigger interno cria ficha pendente na mesma transação do ganho do lead, inclusive para vendedor não administrador, sem conceder acesso financeiro ao vendedor. Unicidade do lead evita duplicações. Ganhos antigos são apenas pendências; datas/custos/comissões não são fabricados.
- Centavos inteiros, reconciliação de comissão e parcelas, recebimentos/devoluções vinculados, movimentos imutáveis e histórico de revisões. Não é um sistema contábil/fiscal.
- Uma revisão alterada por outra sessão ou por um ganho novo bloqueia o salvamento antigo. Recarregar é obrigatório; não há retry silencioso sobrescrevendo dados.
- Reabertura/exclusão lógica do lead não apaga venda financeira. Cancelamentos preservam ficha e exigem devolução dos valores recebidos antes do cancelamento.

## Delimitações desta entrega

- O Financeiro controla **caixa próprio de Geovane**, após os repasses contratuais. Entrada bruta em conta com obrigação de repasse a terceiro não deve ser lançada como recebimento próprio; a direção real desses repasses ainda precisa ser validada antes de um módulo de caixa bruto/escritório.
- Recebimentos são lançados manualmente; não há conciliação bancária, envio de relatórios, pagamento ou transferência automatizados.
- As regras iniciais usam percentual do crédito e distribuição ponderada da comissão própria. Condições de liberação e estorno são texto para conferência manual. Regras reais e outros modelos de remuneração serão cadastrados/ajustados com Geovane após aprovação do layout.
- Cenários de caixa, integrações de atribuição/UTM, CAC/ROI por safra e alterações de etapas do funil continuam evoluções posteriores. As telas não recomendam aumento de mídia com base apenas no volume orgânico.
- Ajustes de saldo inicial após movimentos e correções de condições de vendas com recebimento exigem conciliação; a interface preserva esses registros e não oferece reescrita silenciosa.
- Backups legados de leads não substituem o workspace financeiro. O histórico financeiro tem persistência e auditoria próprias; exportações nesta entrega são demonstrativos CSV.

## Validação e liberação

Testes de dinheiro/calendário/recebimento/caixas, testes PostgreSQL de autorização, revisão, auditoria, ganho atômico, reconciliação e rejeição de recebimento excessivo; suite anterior e builds normal e deploy-preview.

Antes de produção: aprovação visual/funcional de Geovane, verificar os papéis reais de administrador, aplicar e validar a migração no ambiente destinado à operação, conferir pendências antigas, cadastrar regras reais e validar a base de saldo/recebimentos. O PR permanece sem merge até essa aprovação.
