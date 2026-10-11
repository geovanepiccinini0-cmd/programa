// Etapa D — Tarefas comerciais automáticas por etapa do funil.
//
// Função pura, determinística, sem Supabase/React/efeitos colaterais —
// mesmo princípio de followUpEngine.js/followUpSnooze.js: decide O QUE
// deveria existir, nunca escreve nada. A persistência (tasksApi.insertAutoStage,
// db.js) e a decisão de QUANDO chamar (useAppState.js: saveLead/moveStage/
// setLeadStage) vivem em outros módulos — "separe a lógica pura de
// geração da persistência" (requisito da autorização da Etapa D).
//
// `now` é sempre injetado pelo chamador (nunca `new Date()`/`Date.now()`
// interno), mesmo princípio de followUpEngine.js/followUpSnooze.js.

// Origem PRÓPRIA desta fase — nunca confundida com:
// - 'auto' (pendingAutoTasksForLeads/useAppState.js): infraestrutura
//   RESERVADA para uma automação de reativação por proximoContato,
//   nunca chamada automaticamente hoje;
// - 'lead-agenda' (computeLeadAgendaTaskData/useAppState.js): a tarefa
//   "Contato: {nome}" 1:1 com o agendamento (proximoContato) de um lead
//   — Etapa D nunca cria, edita nem remove essa tarefa, e o inverso
//   também nunca acontece;
// - 'rotina' (pendingRotinaTasks/useAppState.js): templates recorrentes
//   do Planner, sem nenhuma relação com leads/etapas;
// - 'manual' (addTask/useAppState.js): criadas explicitamente pelo
//   usuário na tela Hoje;
// - 'automation' (hasPendingTaskWithOrigem('automation'),
//   followUpEngine.js): um blocker JÁ EXISTENTE no motor de follow-up,
//   reservado para uma automação futura ainda não implementada — string
//   DIFERENTE de 'auto_stage' de propósito, para nunca fazer uma tarefa
//   desta Etapa D ser lida (ou bloqueada) pelo motor de follow-up como
//   se fosse aquele outro conceito reservado.
export const AUTO_STAGE_TASK_ORIGEM = 'auto_stage';

// Modelos CONSERVADORES — só as etapas citadas explicitamente na
// autorização (qualificação, proposta, negociação, acompanhamento),
// usando os nomes REAIS de STAGES (constants.js). Deliberadamente DE
// FORA (requisito 5 — "evitando gerar tarefas genéricas em excesso"):
// - 'Novo Lead'/'Ligação'/'Atendimento': fases iniciais já cobertas
//   pela fila de follow-up (Fase 2C) e pelo lead-agenda — uma tarefa
//   automática aqui seria redundante com o que a tela Hoje já mostra.
// - 'Follow-up 2'/'Follow-up 3': "acompanhamento" já ganha UMA tarefa
//   automática ao ENTRAR em 'Follow-up 1' (a primeira etapa da
//   cadência de acompanhamento) — gerar uma nova tarefa a cada
//   avanço de Follow-up 1 -> 2 -> 3 inflaria a lista sem necessidade
//   nova (a mesma tarefa "fazer o acompanhamento" já cobre a
//   intenção); se o produto decidir o contrário, é uma decisão de
//   produto nova, não um esquecimento aqui.
// - 'Ganho'/'Perdido': nunca etapas de acompanhamento comercial
//   (requisito 9 — nunca cria tarefa automática para lead encerrado).
//
// `diasPrazo` é sempre inteiro >= 1 — prazo relativo a `now` no
// momento da TRANSIÇÃO de etapa (nunca a criação do lead).
export const AUTO_STAGE_TASK_RULES = {
  Qualificação: {
    titulo: (nome) => `Qualificar lead: ${nome}`,
    categoria: 'Follow-up',
    diasPrazo: 1,
  },
  Proposta: {
    titulo: (nome) => `Preparar e enviar proposta: ${nome}`,
    categoria: 'Follow-up',
    diasPrazo: 1,
  },
  Negociação: {
    titulo: (nome) => `Negociar condições com: ${nome}`,
    categoria: 'Follow-up',
    diasPrazo: 2,
  },
  'Follow-up 1': {
    titulo: (nome) => `Fazer acompanhamento com: ${nome}`,
    categoria: 'Follow-up',
    diasPrazo: 2,
  },
};

// Correção pós-revisão do PR #76 (achado 4) — a versão anterior fazia
// `new Date(now.getTime() + days*86400000).toISOString().slice(0,10)`:
// somava MILISSEGUNDOS e depois lia o dia em UTC. Para uma operação no
// fuso do Brasil (UTC-3), um clique perto da meia-noite local produzia
// um prazo um dia a mais do que o esperado — ex. `now` = 12/10 23:30
// local (= 13/10 02:30 UTC); +1 dia em ms = 14/10 02:30 UTC ->
// `.toISOString().slice(0,10)` = "2026-10-14", quando o usuário via
// na tela "hoje é 12/10" e esperava "13/10" (hoje + 1 dia civil).
//
// A correção opera SÓ nos componentes de calendário LOCAIS de `now`
// (getFullYear/getMonth/getDate — sempre no fuso do navegador que
// executa o código, nunca UTC) e deixa o próprio `Date` normalizar
// overflow de mês/ano (ex. dia 31 + 2 em janeiro vira o dia certo de
// março) — nunca soma milissegundos/dias em UTC. Robusto a DST: como
// a aritmética é em CAMPOS de calendário (dia civil), não em instante
// absoluto, um horário de verão no meio do intervalo não desloca o
// resultado em uma hora como aconteceria somando 86400000ms fixos.
function addLocalDaysStr(now, days) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Requisito 3 — só uma mudança EFETIVA de etapa pode gerar a tarefa.
// `prevEtapa` ausente (lead recém-criado, nunca existiu antes) nunca
// gera tarefa aqui — mesmo princípio já aplicado a
// computeStageChangeInteraction (useAppState.js): criar um lead já
// numa etapa avançada não é uma "mudança" de etapa, é o estado inicial
// dele. Re-renderização/salvar o cadastro sem alterar `etapa`
// (prevEtapa === newEtapa) também nunca gera tarefa — é exatamente o
// que esta checagem garante.
export function shouldGenerateAutoStageTask({ prevEtapa, newEtapa }) {
  return Boolean(prevEtapa) && prevEtapa !== newEtapa;
}

// Requisito 2/5/9 — resolve o modelo da etapa ATUAL do lead (depois da
// transição) e monta os dados da tarefa, ou `null` quando: lead
// ausente/sem etapa, lead arquivado/excluído (`deletedAt`, soft-delete
// da Fase 1.13 — ainda não ativado na UI, mas checado aqui por
// segurança, mesmo princípio defensivo de followUpEngine.js), ou a
// etapa não tem modelo configurado (inclui Ganho/Perdido, que nunca
// aparecem em AUTO_STAGE_TASK_RULES). `etapaGatilho` fica registrado
// na própria tarefa (coluna nova `etapa_gatilho`, migration 028) —
// é o que permite o dedupe por "mesmo lead + mesmo evento de entrada
// na etapa" (requisito 6) sem precisar adivinhar a partir do título.
export function computeAutoStageTaskData(lead, now) {
  if (!lead || !lead.etapa || lead.deletedAt) return null;
  const rule = AUTO_STAGE_TASK_RULES[lead.etapa];
  if (!rule) return null;
  return {
    titulo: rule.titulo(lead.nome),
    categoria: rule.categoria,
    data: addLocalDaysStr(now, rule.diasPrazo),
    horario: '',
    concluida: false,
    leadId: lead.id,
    origem: AUTO_STAGE_TASK_ORIGEM,
    etapaGatilho: lead.etapa,
  };
}

// Requisito 6 (1ª linha de defesa, client-side) — já existe uma tarefa
// automática PENDENTE para este lead + esta etapa específica? A
// condição de idempotência "de verdade" (requisito 7, duas abas/
// corrida) é garantida pelo índice único parcial no banco (migration
// 028: `unique (lead_id, etapa_gatilho) where origem='auto_stage' and
// concluida=false`) — esta função só evita a tentativa óbvia de
// escrita duplicada antes de ir ao banco, nunca é a única barreira.
// Uma tarefa já CONCLUÍDA para a mesma etapa nunca bloqueia uma nova
// (requisito 8 — histórico preservado; um novo ciclo pela mesma etapa
// é um novo "evento de entrada", merece sua própria tarefa).
//
// LIMITAÇÃO EXPLÍCITA (achado 6 da revisão do PR #76) — o dedupe
// (tanto este quanto o índice do banco) é por "(lead, etapa) com uma
// tarefa PENDENTE", NUNCA por "evento de entrada" individual. Dois
// cenários onde isso importa, de propósito:
// 1) Reentrada ENQUANTO a tarefa anterior ainda está pendente: se o
//    lead sai de 'Proposta' e volta para 'Proposta' outra vez antes
//    de concluir a tarefa da primeira entrada, NENHUMA segunda tarefa
//    é criada — a pendente já existente cobre as duas entradas. Isso
//    é intencional (evita duplicar o mesmo pedido de ação enquanto
//    ele continua válido), não um bug.
// 2) Reentrada DEPOIS de concluir ou a tarefa ser cancelada/excluída:
//    aí sim uma nova tarefa é gerada — não há mais nenhuma linha
//    pendente para (lead, etapa) bloqueando. "Cancelar" aqui significa
//    excluir a tarefa pelos controles genéricos já existentes
//    (onDeleteTask) — o mesmo efeito de "concluída" para fins deste
//    dedupe, já que ambos retiram a linha do conjunto "pendente".
// Produto pode decidir no futuro que cada entrada merece sua própria
// tarefa mesmo com uma ainda pendente — isso é uma decisão de domínio
// NOVA, documentada aqui para nunca ficar implícita.
export function hasPendingAutoStageTask(tasks, leadId, etapa) {
  return tasks.some((t) => t.leadId === leadId && t.origem === AUTO_STAGE_TASK_ORIGEM && t.etapaGatilho === etapa && !t.concluida);
}

// Ponto de entrada único, composto a partir das três funções puras
// acima — reutilizado IDENTICAMENTE pelas três vias de mudança de
// etapa (saveLead via formulário, moveStage via Kanban, setLeadStage
// via seleção direta — requisito "teste mudanças pelo Kanban e pelo
// formulário de edição"), nunca reimplementado três vezes. Retorna os
// dados da tarefa a inserir, ou `null` quando nada deve ser criado —
// o chamador (useAppState.js) só decide COMO persistir isso.
export function buildAutoStageTaskAction({ prevEtapa, updatedLead, tasks, now }) {
  if (!shouldGenerateAutoStageTask({ prevEtapa, newEtapa: updatedLead && updatedLead.etapa })) return null;
  const taskData = computeAutoStageTaskData(updatedLead, now);
  if (!taskData) return null;
  if (hasPendingAutoStageTask(tasks, updatedLead.id, updatedLead.etapa)) return null;
  return taskData;
}
