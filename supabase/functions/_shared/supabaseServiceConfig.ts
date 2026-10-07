// Fase 3.2.3.1 — Leitura e validação da configuração do client
// service-role do Supabase (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
//
// Responsabilidade ÚNICA: ler exatamente essas duas variáveis através
// de um envReader injetado e validar que ambas são strings não-vazias
// e não-whitespace-only. NUNCA acessa Deno.env diretamente — isso
// mantém este módulo 100% testável em Vitest/Node, sem runtime Deno,
// sem rede, sem secret real.
//
// Fail-closed: ausência/whitespace em qualquer uma das duas variáveis
// lança (nunca retorna um config parcial, nunca cai para um default
// hardcoded, nunca cai para a anon key). Quem compõe este módulo com o
// Deno real (Fase 3.2.3.2, fora desta fase) é responsável por passar
// `(key) => Deno.env.get(key)` como envReader — este arquivo nunca
// sabe disso e nunca precisa saber.
//
// Vive em supabase/functions/_shared/ — fora de src/, nunca alcançado
// pelo build do Vite/bundle do browser. Zero import de qualquer outro
// módulo deste projeto (src/, React, @supabase/supabase-js, o
// repository ou o resolver puro).

export interface SupabaseServiceConfig {
  url: string;
  serviceRoleKey: string;
}

export type EnvReader = (key: string) => string | undefined;

const ENV_KEY_URL = 'SUPABASE_URL';
const ENV_KEY_SERVICE_ROLE_KEY = 'SUPABASE_SERVICE_ROLE_KEY';

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Mensagens de erro são sempre literais fixas — nunca interpolam o
// valor lido, o nome completo de env, ou qualquer parte do config.
// Isso garante que uma secret real (ou um valor fake usado em teste)
// jamais apareça em error.message produzida por este módulo.
function missingOrBlank(envKeyLabel: string): never {
  throw new Error(`readSupabaseServiceConfig: ${envKeyLabel} ausente ou vazia (nao pode ser whitespace-only)`);
}

export function readSupabaseServiceConfig(envReader: EnvReader): SupabaseServiceConfig {
  if (typeof envReader !== 'function') {
    throw new TypeError('readSupabaseServiceConfig: envReader deve ser uma function');
  }

  const url = envReader(ENV_KEY_URL);
  if (!isNonBlankString(url)) {
    missingOrBlank('SUPABASE_URL');
  }

  const serviceRoleKey = envReader(ENV_KEY_SERVICE_ROLE_KEY);
  if (!isNonBlankString(serviceRoleKey)) {
    missingOrBlank('SUPABASE_SERVICE_ROLE_KEY');
  }

  // Valores retornados byte-for-byte, sem trim/normalização/decode —
  // só a checagem de forma usa .trim(), nunca o valor propagado.
  return { url, serviceRoleKey };
}
