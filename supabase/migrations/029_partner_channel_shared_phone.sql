-- Canal Parceiro: um mesmo telefone pode representar o contato do parceiro
-- em oportunidades distintas. Demais canais mantêm unicidade por usuário.
-- Índice parcial preserva soft-delete e ignora telefones não normalizados.
BEGIN;
DROP INDEX IF EXISTS public.leads_user_id_phone_normalized_active_key;
CREATE UNIQUE INDEX leads_user_id_phone_normalized_active_key
  ON public.leads (user_id, phone_normalized)
  WHERE deleted_at IS NULL
    AND phone_normalized IS NOT NULL
    AND canal IS DISTINCT FROM 'Parceiro';
COMMIT;
