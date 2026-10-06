export const STAGES = ['Novo Lead', 'Ligação', 'Qualificação', 'Atendimento', 'Proposta', 'Negociação', 'Follow-up 1', 'Follow-up 2', 'Follow-up 3', 'Ganho', 'Perdido'];
export const PRODUTOS = ['Consórcio', 'Carta Contemplada', 'Home Equity', 'Financiamento', 'Imóvel'];
export const CANAIS = ['Facebook Marketplace', 'Tráfego Pago', 'Indicação', 'Prospecção Ativa', 'Instagram/TikTok', 'Cliente', 'Attemics', 'Insta Felipe'];
export const CATS_TASK = ['Follow-up', 'Conteúdo', 'Agenda/Ligação', 'Operacional'];
export const DIAS_SEMANA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
export const PROD_COLOR = {
  Consórcio: 'var(--blue)',
  'Carta Contemplada': 'var(--gold)',
  'Home Equity': 'var(--teal)',
  Financiamento: 'var(--red)',
  Imóvel: 'var(--purple)',
};
export const STALE_DAYS = 15;
export const TAGS_LEAD = ['S/ CONDIÇÃO', 'C/ CONDIÇÃO', 'N/ RESPONDE', 'CARRO ENTR.', 'RESTRIÇÃO', 'PRIORIDADE', 'ATENÇÃO'];
export const TAG_COLOR = {
  'S/ CONDIÇÃO': 'var(--red)',
  'C/ CONDIÇÃO': 'var(--green)',
  'N/ RESPONDE': 'var(--orange)',
  'CARRO ENTR.': 'var(--blue)',
  RESTRIÇÃO: 'var(--orange)',
  PRIORIDADE: 'var(--purple)',
  ATENÇÃO: 'var(--orange)',
};
export const BUILD_VERSION = 'v2.0-foundation';

// --- V2 (Fase 1 — fundação técnica) ---

export const NEXT_ACTION_TYPES = [
  { value: 'call', label: 'Ligação' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'meeting', label: 'Reunião' },
  { value: 'proposal', label: 'Proposta' },
  { value: 'follow_up', label: 'Follow-up' },
  { value: 'other', label: 'Outro' },
];

export const LEAD_TEMPERATURES = [
  { value: 'cold', label: 'Frio', color: 'var(--blue)' },
  { value: 'warm', label: 'Morno', color: 'var(--orange)' },
  { value: 'hot', label: 'Quente', color: 'var(--red)' },
];

export const PRIORITIES = [
  { value: 'low', label: 'Baixa' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'Alta' },
  { value: 'urgent', label: 'Urgente' },
];

export const LOST_REASONS = [
  { value: 'sem_condicao', label: 'Sem condição' },
  { value: 'sem_interesse', label: 'Sem interesse' },
  { value: 'nao_responde', label: 'Não responde' },
  { value: 'fechou_concorrente', label: 'Fechou com concorrente' },
  { value: 'credito_reprovado', label: 'Crédito reprovado' },
  { value: 'adiou_decisao', label: 'Adiou decisão' },
  { value: 'outro', label: 'Outro' },
];

export const INTERACTION_TYPE_LABEL = {
  note: 'Nota',
  call: 'Ligação',
  whatsapp: 'WhatsApp',
  follow_up: 'Follow-up',
  meeting: 'Reunião',
  proposal: 'Proposta',
  stage_change: 'Mudança de etapa',
  system: 'Sistema',
};

export const INTERACTION_CHANNEL_LABEL = {
  manual: 'Manual',
  phone: 'Telefone',
  crm: 'CRM',
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  email: 'E-mail',
  in_person: 'Presencial',
};

// Fase 2A.2 — registro rápido de interações comerciais. `value` é a chave
// usada por computeCommercialInteractionData (useAppState.js); `group`
// organiza a UX de 2 níveis no LeadTimeline (categoria -> ação final).
export const COMMERCIAL_INTERACTION_ACTIONS = [
  { value: 'call_connected', label: 'Atendeu', group: 'call' },
  { value: 'call_no_answer', label: 'Não atendeu', group: 'call' },
  { value: 'whatsapp_sent', label: 'Enviado', group: 'whatsapp' },
  { value: 'whatsapp_received', label: 'Cliente respondeu', group: 'whatsapp' },
  { value: 'meeting_held', label: 'Reunião realizada', group: 'more' },
  { value: 'proposal_sent', label: 'Proposta enviada', group: 'more' },
];

export const COMMERCIAL_INTERACTION_GROUPS = [
  { value: 'call', label: '📞 Ligação' },
  { value: 'whatsapp', label: '💬 WhatsApp' },
  { value: 'more', label: '+ Mais' },
];

// Fase 2B/2C.1 — tipos que representam contato comercial de verdade
// (ligação, WhatsApp, reunião). 'proposal' fica deliberadamente de fora:
// continua activity_class='attempt' no Activity Engine (não mexe nessa
// classificação), mas não conta como "tentativa de contato" para
// computeLastContactAttemptAt (useAppState.js) nem para o
// Follow-up Eligibility Engine (followUpEngine.js) — enviar uma
// proposta não deve reiniciar a cadência de tentativa de contato.
// Vive aqui (módulo-folha, zero imports) de propósito: tanto
// useAppState.js quanto followUpEngine.js importam daqui, nunca um do
// outro — followUpEngine.js não pode depender de React/Supabase.
export const CONTACT_ATTEMPT_TYPES = ['call', 'whatsapp', 'meeting'];
