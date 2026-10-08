import { describe, expect, test } from 'vitest';
import {
  whatsappMessageFromRow,
  messageDisplayText,
  messagePreviewText,
  buildConversationSummaries,
  sortConversationsByRecency,
  sortMessagesChronologically,
  mergeOlderPage,
  mergeFetchedSnapshot,
  mergeRealtimeMessage,
  subscribeToWhatsAppInboxRealtime,
} from './whatsappMessages.js';

function row(overrides = {}) {
  return {
    id: 'msg-1',
    user_id: 'user-1',
    lead_id: 'lead-1',
    integration_account_id: 'ia-1',
    integration_event_id: 'evt-1',
    lead_interaction_id: 'int-1',
    provider: 'whatsapp',
    external_message_id: 'wamid.X',
    direction: 'inbound',
    message_type: 'text',
    content: 'Oi, quero informações',
    status: 'received',
    error_code: null,
    occurred_at: '2026-01-01T12:00:00.000Z',
    sent_at: null,
    delivered_at: null,
    read_at: null,
    created_at: '2026-01-01T12:00:01.000Z',
    ...overrides,
  };
}

describe('whatsappMessageFromRow', () => {
  test('mapeia todas as colunas reais da migration 018 para camelCase', () => {
    const mapped = whatsappMessageFromRow(row());
    expect(mapped).toEqual({
      id: 'msg-1',
      userId: 'user-1',
      leadId: 'lead-1',
      integrationAccountId: 'ia-1',
      integrationEventId: 'evt-1',
      leadInteractionId: 'int-1',
      provider: 'whatsapp',
      externalMessageId: 'wamid.X',
      direction: 'inbound',
      messageType: 'text',
      content: 'Oi, quero informações',
      status: 'received',
      errorCode: null,
      occurredAt: '2026-01-01T12:00:00.000Z',
      sentAt: null,
      deliveredAt: null,
      readAt: null,
      createdAt: '2026-01-01T12:00:01.000Z',
    });
  });
});

describe('messageDisplayText / messagePreviewText', () => {
  test('mensagem textual retorna o conteudo verbatim (sem alteracao/escaping manual)', () => {
    const m = whatsappMessageFromRow(row({ content: 'Olá, tudo bem?' }));
    expect(messageDisplayText(m)).toBe('Olá, tudo bem?');
  });

  test('conteudo contendo marcacao tipo HTML e retornado LITERALMENTE, nunca interpretado/removido aqui (a seguranca vem do React no render, nunca de manipulacao de string)', () => {
    const malicious = '<script>alert(1)</script><img src=x onerror=alert(2)>';
    const m = whatsappMessageFromRow(row({ content: malicious }));
    expect(messageDisplayText(m)).toBe(malicious);
  });

  test('mensagem nao-textual (image) sem content -> placeholder, nunca tenta mostrar midia', () => {
    const m = whatsappMessageFromRow(row({ content: null, message_type: 'image' }));
    expect(messageDisplayText(m)).toBe('📷 Imagem');
  });

  test.each(['audio', 'video', 'document', 'sticker', 'location', 'contacts'])(
    'placeholder existe para message_type=%s',
    (type) => {
      const m = whatsappMessageFromRow(row({ content: null, message_type: type }));
      expect(messageDisplayText(m)).not.toBe('');
      expect(messageDisplayText(m)).not.toContain('undefined');
    },
  );

  test('message_type desconhecido sem content -> fallback generico, nunca lanca', () => {
    const m = whatsappMessageFromRow(row({ content: null, message_type: 'unknown_future_type' }));
    expect(messageDisplayText(m)).toBe('📎 Mensagem');
  });

  test('message null/undefined -> string vazia, nunca lanca', () => {
    expect(messageDisplayText(null)).toBe('');
    expect(messageDisplayText(undefined)).toBe('');
  });

  test('preview trunca texto longo com elipse, preserva texto curto integralmente', () => {
    const longo = 'a'.repeat(100);
    const m = whatsappMessageFromRow(row({ content: longo }));
    const preview = messagePreviewText(m, 60);
    expect(preview.length).toBe(60);
    expect(preview.endsWith('…')).toBe(true);

    const curto = whatsappMessageFromRow(row({ content: 'oi' }));
    expect(messagePreviewText(curto, 60)).toBe('oi');
  });
});

describe('buildConversationSummaries', () => {
  test('agrupa por lead, mantendo so a mensagem mais recente de cada', () => {
    const messages = [
      whatsappMessageFromRow(row({ id: 'm1', lead_id: 'lead-A', occurred_at: '2026-01-01T10:00:00.000Z', content: 'antiga A' })),
      whatsappMessageFromRow(row({ id: 'm2', lead_id: 'lead-A', occurred_at: '2026-01-02T10:00:00.000Z', content: 'recente A' })),
      whatsappMessageFromRow(row({ id: 'm3', lead_id: 'lead-B', occurred_at: '2026-01-01T09:00:00.000Z', content: 'unica B' })),
    ];
    const summaries = buildConversationSummaries(messages, { 'lead-A': 'Fulano', 'lead-B': 'Ciclano' });
    expect(summaries).toHaveLength(2);
    const a = summaries.find((s) => s.leadId === 'lead-A');
    expect(a.lastMessage.id).toBe('m2');
    expect(a.preview).toBe('recente A');
    expect(a.leadNome).toBe('Fulano');
  });

  test('funciona independente da ordem de entrada do array', () => {
    const messages = [
      whatsappMessageFromRow(row({ id: 'm2', lead_id: 'lead-A', occurred_at: '2026-01-02T10:00:00.000Z' })),
      whatsappMessageFromRow(row({ id: 'm1', lead_id: 'lead-A', occurred_at: '2026-01-01T10:00:00.000Z' })),
    ];
    const summaries = buildConversationSummaries(messages);
    expect(summaries[0].lastMessage.id).toBe('m2');
  });

  test('lead sem nome conhecido cai no fallback "Lead", nunca lanca', () => {
    const messages = [whatsappMessageFromRow(row({ lead_id: 'lead-desconhecido' }))];
    const summaries = buildConversationSummaries(messages, {});
    expect(summaries[0].leadNome).toBe('Lead');
  });

  test('lista vazia -> lista vazia', () => {
    expect(buildConversationSummaries([])).toEqual([]);
  });
});

describe('sortConversationsByRecency', () => {
  test('ordena por lastMessageAt desc, nunca muta o array original', () => {
    const conversations = [
      { leadId: 'a', lastMessageAt: '2026-01-01T00:00:00.000Z' },
      { leadId: 'b', lastMessageAt: '2026-01-03T00:00:00.000Z' },
      { leadId: 'c', lastMessageAt: '2026-01-02T00:00:00.000Z' },
    ];
    const sorted = sortConversationsByRecency(conversations);
    expect(sorted.map((c) => c.leadId)).toEqual(['b', 'c', 'a']);
    expect(conversations.map((c) => c.leadId)).toEqual(['a', 'b', 'c']); // original intacto
  });
});

describe('sortMessagesChronologically', () => {
  test('ordena por occurredAt asc (mais antiga primeiro), independente da ordem de entrada', () => {
    const messages = [
      whatsappMessageFromRow(row({ id: 'm3', occurred_at: '2026-01-03T00:00:00.000Z' })),
      whatsappMessageFromRow(row({ id: 'm1', occurred_at: '2026-01-01T00:00:00.000Z' })),
      whatsappMessageFromRow(row({ id: 'm2', occurred_at: '2026-01-02T00:00:00.000Z' })),
    ];
    const sorted = sortMessagesChronologically(messages);
    expect(sorted.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  // Fase 3.5.1 — correção do finding HIGH: occurred_at tem granularidade
  // de segundo, então empates são plausíveis. O tiebreak por `id`
  // garante ordem ESTÁVEL e determinística (nunca embaralha mensagens
  // empatadas de forma diferente entre chamadas).
  test('timestamps idênticos -> tiebreak determinístico por id, estável entre chamadas repetidas', () => {
    const messages = [
      whatsappMessageFromRow(row({ id: 'm-c', occurred_at: '2026-01-01T12:00:00.000Z' })),
      whatsappMessageFromRow(row({ id: 'm-a', occurred_at: '2026-01-01T12:00:00.000Z' })),
      whatsappMessageFromRow(row({ id: 'm-b', occurred_at: '2026-01-01T12:00:00.000Z' })),
    ];
    const sorted1 = sortMessagesChronologically(messages);
    const sorted2 = sortMessagesChronologically([...messages].reverse());
    expect(sorted1.map((m) => m.id)).toEqual(['m-a', 'm-b', 'm-c']);
    expect(sorted2.map((m) => m.id)).toEqual(['m-a', 'm-b', 'm-c']); // mesma ordem, input diferente
  });

  test('mistura de timestamps iguais e diferentes -> occurredAt ainda tem prioridade sobre id', () => {
    const messages = [
      whatsappMessageFromRow(row({ id: 'z', occurred_at: '2026-01-02T00:00:00.000Z' })),
      whatsappMessageFromRow(row({ id: 'b', occurred_at: '2026-01-01T00:00:00.000Z' })),
      whatsappMessageFromRow(row({ id: 'a', occurred_at: '2026-01-01T00:00:00.000Z' })),
    ];
    const sorted = sortMessagesChronologically(messages);
    expect(sorted.map((m) => m.id)).toEqual(['a', 'b', 'z']);
  });
});

describe('mergeFetchedSnapshot — correção do finding MEDIUM (corrida fetch vs Realtime)', () => {
  test('mensagem entregue pelo Realtime ENQUANTO o fetch estava em voo nunca e apagada pelo snapshot buscado', () => {
    const deliveredByRealtimeDuringFlight = whatsappMessageFromRow(row({ id: 'm-realtime', occurred_at: '2026-01-05T00:00:00.000Z' }));
    const current = [deliveredByRealtimeDuringFlight];
    // O snapshot buscado nao contem m-realtime (a consulta ao banco foi
    // disparada ANTES dela existir).
    const fetchedSnapshot = [whatsappMessageFromRow(row({ id: 'm-antiga', occurred_at: '2026-01-01T00:00:00.000Z' }))];
    const merged = mergeFetchedSnapshot(current, fetchedSnapshot);
    expect(merged.map((m) => m.id).sort()).toEqual(['m-antiga', 'm-realtime']);
  });

  test('merge nunca duplica — id presente nos dois usa a versao do snapshot buscado (leitura mais fresca)', () => {
    const current = [whatsappMessageFromRow(row({ id: 'm1', status: 'received' }))];
    const fetched = [whatsappMessageFromRow(row({ id: 'm1', status: 'processed' }))];
    const merged = mergeFetchedSnapshot(current, fetched);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('processed');
  });

  test('current vazio -> resultado e exatamente o snapshot buscado', () => {
    const fetched = [whatsappMessageFromRow(row({ id: 'm1' })), whatsappMessageFromRow(row({ id: 'm2' }))];
    const merged = mergeFetchedSnapshot([], fetched);
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  test('snapshot buscado vazio -> preserva integralmente o current (nunca apaga por um fetch vazio)', () => {
    const current = [whatsappMessageFromRow(row({ id: 'm1' }))];
    const merged = mergeFetchedSnapshot(current, []);
    expect(merged.map((m) => m.id)).toEqual(['m1']);
  });
});

describe('mergeOlderPage', () => {
  test('prepend de pagina mais antiga (vinda em ordem desc) na ordem ascendente correta', () => {
    const existingAscending = [
      whatsappMessageFromRow(row({ id: 'm3', occurred_at: '2026-01-03T00:00:00.000Z' })),
      whatsappMessageFromRow(row({ id: 'm4', occurred_at: '2026-01-04T00:00:00.000Z' })),
    ];
    // pagina mais antiga, como viria de uma query ORDER BY occurred_at DESC
    const olderPageDesc = [
      whatsappMessageFromRow(row({ id: 'm2', occurred_at: '2026-01-02T00:00:00.000Z' })),
      whatsappMessageFromRow(row({ id: 'm1', occurred_at: '2026-01-01T00:00:00.000Z' })),
    ];
    const merged = mergeOlderPage(existingAscending, olderPageDesc);
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  test('nunca duplica um id ja presente (idempotente a reaplicacoes)', () => {
    const existingAscending = [whatsappMessageFromRow(row({ id: 'm1' }))];
    const olderPageDesc = [whatsappMessageFromRow(row({ id: 'm1' }))];
    const merged = mergeOlderPage(existingAscending, olderPageDesc);
    expect(merged).toHaveLength(1);
  });
});

describe('subscribeToWhatsAppInboxRealtime — correção do finding MEDIUM (nomes de lead desatualizados, sem subscription duplicada)', () => {
  function makeFakeSupabaseClient() {
    const onCalls = [];
    const removeChannelCalls = [];
    const channelCalls = [];
    const channel = {
      on(...args) { onCalls.push(args); return channel; },
      subscribe() { return channel; },
    };
    const client = {
      channel(name) { channelCalls.push(name); return channel; },
      removeChannel(ch) { removeChannelCalls.push(ch); },
    };
    client._onCalls = onCalls;
    client._removeChannelCalls = removeChannelCalls;
    client._channelCalls = channelCalls;
    client._channel = channel;
    return client;
  }

  test('um UNICO canal (uma unica chamada a .channel()) escutando whatsapp_messages E leads — nunca dois canais separados', () => {
    const client = makeFakeSupabaseClient();
    subscribeToWhatsAppInboxRealtime(client, { onMessageChange: () => {}, onLeadChange: () => {} });
    expect(client._channelCalls).toHaveLength(1);
    expect(client._onCalls).toHaveLength(2);
    const tables = client._onCalls.map(([, config]) => config.table);
    expect(tables.sort()).toEqual(['leads', 'whatsapp_messages']);
    client._onCalls.forEach(([eventName, config]) => {
      expect(eventName).toBe('postgres_changes');
      expect(config.event).toBe('*');
      expect(config.schema).toBe('public');
    });
  });

  test('onMessageChange e onLeadChange sao repassados exatamente aos handlers corretos (nunca trocados)', () => {
    const client = makeFakeSupabaseClient();
    const onMessageChange = () => {};
    const onLeadChange = () => {};
    subscribeToWhatsAppInboxRealtime(client, { onMessageChange, onLeadChange });
    const messageCall = client._onCalls.find(([, config]) => config.table === 'whatsapp_messages');
    const leadCall = client._onCalls.find(([, config]) => config.table === 'leads');
    expect(messageCall[2]).toBe(onMessageChange);
    expect(leadCall[2]).toBe(onLeadChange);
  });

  test('a funcao de limpeza retornada chama removeChannel com EXATAMENTE o UNICO canal criado', () => {
    const client = makeFakeSupabaseClient();
    const unsubscribe = subscribeToWhatsAppInboxRealtime(client, { onMessageChange: () => {}, onLeadChange: () => {} });
    expect(client._removeChannelCalls).toHaveLength(0);
    unsubscribe();
    expect(client._removeChannelCalls).toEqual([client._channel]);
  });
});

describe('mergeRealtimeMessage', () => {
  test('INSERT de mensagem nova -> adicionada ao final', () => {
    const existing = [whatsappMessageFromRow(row({ id: 'm1' }))];
    const payload = { eventType: 'INSERT', new: row({ id: 'm2' }) };
    const merged = mergeRealtimeMessage(existing, payload);
    expect(merged.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  test('UPDATE de mensagem existente -> upsert no mesmo indice, nunca duplica', () => {
    const existing = [whatsappMessageFromRow(row({ id: 'm1', status: 'received' }))];
    const payload = { eventType: 'UPDATE', new: row({ id: 'm1', status: 'processed' }) };
    const merged = mergeRealtimeMessage(existing, payload);
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('processed');
  });

  test('DELETE remove pelo id antigo', () => {
    const existing = [whatsappMessageFromRow(row({ id: 'm1' })), whatsappMessageFromRow(row({ id: 'm2' }))];
    const payload = { eventType: 'DELETE', old: { id: 'm1' } };
    const merged = mergeRealtimeMessage(existing, payload);
    expect(merged.map((m) => m.id)).toEqual(['m2']);
  });

  test('payload nulo/invalido nunca lanca -> retorna a lista inalterada', () => {
    const existing = [whatsappMessageFromRow(row({ id: 'm1' }))];
    expect(mergeRealtimeMessage(existing, null)).toBe(existing);
  });
});
