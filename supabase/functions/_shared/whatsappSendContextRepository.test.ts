import { describe, expect, test } from 'vitest';
import { resolveOutboundSendContext, OUTBOUND_MESSAGING_WINDOW_MS } from './whatsappSendContextRepository.ts';

const NOW = new Date('2026-01-10T12:00:00.000Z');
const fixedNow = () => NOW;

interface TableRows {
  leads?: unknown[];
  whatsapp_messages?: unknown[];
  integration_accounts?: unknown[];
}

function makeFakeClient(rows: TableRows, errorOnTable?: string) {
  const calls: Array<{ table: string; filters: Record<string, unknown> }> = [];
  return {
    from(table: string) {
      return {
        select() {
          const filters: Record<string, unknown> = {};
          const chain = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return chain;
            },
            order() {
              return {
                limit: async () => {
                  calls.push({ table, filters });
                  if (errorOnTable === table) return { data: null, error: new Error('boom') };
                  return { data: rows[table as keyof TableRows] ?? [], error: null };
                },
              };
            },
            then(resolve: (value: { data: unknown[] | null; error: unknown }) => unknown) {
              calls.push({ table, filters });
              const result = errorOnTable === table
                ? { data: null, error: new Error('boom') }
                : { data: rows[table as keyof TableRows] ?? [], error: null };
              return Promise.resolve(result).then(resolve);
            },
          };
          return chain;
        },
      };
    },
    _calls: calls,
  };
}

const USER_ID = 'user-1';
const LEAD_ID = 'lead-1';

describe('resolveOutboundSendContext', () => {
  test('lead com inbound recente e conta ativa -> OK com contexto resolvido do BANCO (nunca do chamador)', async () => {
    const client = makeFakeClient({
      leads: [{ id: LEAD_ID, user_id: USER_ID, deleted_at: null, phone_normalized: '5551900000001' }],
      whatsapp_messages: [{ integration_account_id: 'acc-1', occurred_at: '2026-01-10T00:00:00.000Z' }],
      integration_accounts: [{ id: 'acc-1', active: true, user_id: USER_ID, external_account_id: 'phone-number-id-A' }],
    });
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('OK');
    if (result.status === 'OK') {
      expect(result.context.integrationAccountId).toBe('acc-1');
      expect(result.context.phoneNumberId).toBe('phone-number-id-A');
      expect(result.context.recipientPhoneNormalized).toBe('5551900000001');
      expect(result.context.windowExpiresAt.toISOString()).toBe(
        new Date(new Date('2026-01-10T00:00:00.000Z').getTime() + OUTBOUND_MESSAGING_WINDOW_MS).toISOString(),
      );
    }
  });

  test('lead inexistente -> LEAD_NOT_FOUND', async () => {
    const client = makeFakeClient({ leads: [] });
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('LEAD_NOT_FOUND');
  });

  test('lead pertencente a outro usuario -> LEAD_FORBIDDEN, nunca resolve contexto', async () => {
    const client = makeFakeClient({
      leads: [{ id: LEAD_ID, user_id: 'outro-usuario', deleted_at: null, phone_normalized: '5551900000001' }],
    });
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('LEAD_FORBIDDEN');
  });

  test('lead soft-deletado -> LEAD_DELETED', async () => {
    const client = makeFakeClient({
      leads: [{ id: LEAD_ID, user_id: USER_ID, deleted_at: '2026-01-05T00:00:00.000Z', phone_normalized: '5551900000001' }],
    });
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('LEAD_DELETED');
  });

  test('lead sem nenhuma conversa inbound -> NO_INBOUND_CONVERSATION (decisao V1)', async () => {
    const client = makeFakeClient({
      leads: [{ id: LEAD_ID, user_id: USER_ID, deleted_at: null, phone_normalized: '5551900000001' }],
      whatsapp_messages: [],
    });
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('NO_INBOUND_CONVERSATION');
  });

  test('conta de integracao inativa -> INTEGRATION_ACCOUNT_INACTIVE', async () => {
    const client = makeFakeClient({
      leads: [{ id: LEAD_ID, user_id: USER_ID, deleted_at: null, phone_normalized: '5551900000001' }],
      whatsapp_messages: [{ integration_account_id: 'acc-1', occurred_at: '2026-01-10T00:00:00.000Z' }],
      integration_accounts: [{ id: 'acc-1', active: false, user_id: USER_ID, external_account_id: 'phone-number-id-A' }],
    });
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('INTEGRATION_ACCOUNT_INACTIVE');
  });

  test('conta de integracao de outro usuario (anomalia) -> INTEGRATION_ACCOUNT_INACTIVE, fail-closed', async () => {
    const client = makeFakeClient({
      leads: [{ id: LEAD_ID, user_id: USER_ID, deleted_at: null, phone_normalized: '5551900000001' }],
      whatsapp_messages: [{ integration_account_id: 'acc-1', occurred_at: '2026-01-10T00:00:00.000Z' }],
      integration_accounts: [{ id: 'acc-1', active: true, user_id: 'outro-usuario', external_account_id: 'phone-number-id-A' }],
    });
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('INTEGRATION_ACCOUNT_INACTIVE');
  });

  test('janela de 24h encerrada -> WINDOW_CLOSED com windowExpiresAt', async () => {
    const client = makeFakeClient({
      leads: [{ id: LEAD_ID, user_id: USER_ID, deleted_at: null, phone_normalized: '5551900000001' }],
      whatsapp_messages: [{ integration_account_id: 'acc-1', occurred_at: '2026-01-08T00:00:00.000Z' }],
      integration_accounts: [{ id: 'acc-1', active: true, user_id: USER_ID, external_account_id: 'phone-number-id-A' }],
    });
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('WINDOW_CLOSED');
  });

  test('erro do client na query de leads -> REPOSITORY_ERROR', async () => {
    const client = makeFakeClient({ leads: [] }, 'leads');
    const result = await resolveOutboundSendContext({ userId: USER_ID, leadId: LEAD_ID }, client, fixedNow);
    expect(result.status).toBe('REPOSITORY_ERROR');
  });

  test('userId vazio -> lanca antes de qualquer query', async () => {
    const client = makeFakeClient({});
    await expect(resolveOutboundSendContext({ userId: '', leadId: LEAD_ID }, client, fixedNow)).rejects.toThrow(TypeError);
    expect(client._calls).toHaveLength(0);
  });
});
