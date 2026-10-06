// Edge Function de health check — Fase 1 da fundação técnica da V2.
//
// Não acessa banco de dados, não usa SERVICE_ROLE_KEY, não acessa nenhum
// dado sensível ou de usuário. Existe só para confirmar que a camada
// server-side (Supabase Edge Functions) está disponível e operacional,
// preparando o terreno para futuros webhooks/jobs (WhatsApp, Meta, IA) —
// nenhum deles é configurado nesta fase.
//
// Deploy (manual, feito pelo usuário — este ambiente não tem acesso de
// rede ao projeto Supabase para fazer isso automaticamente):
//   supabase functions deploy health
//
// Teste depois do deploy:
//   curl https://SEU-PROJETO.supabase.co/functions/v1/health

const VERSION = '2.0-foundation';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve((req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const body = JSON.stringify({
    ok: true,
    service: 'crm-piccinini',
    version: VERSION,
  });

  return new Response(body, {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
