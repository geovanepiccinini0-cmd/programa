import { useCallback, useRef, useState } from 'react';

// Fase 2D.1 — orquestração pura (testável sem renderizar nada, mesmo
// padrão de runCompleteTaskWithResult em useAppState.js): guard de duplo
// clique + chamada a onRegisterInteraction + aplicação do resultado via
// os setters injetados. Nunca decide UI — isso fica por conta de quem
// chama (LeadTimeline, ou o picker de ligação de FollowUpQueue.jsx).
//
// Fase 2D.1.2 — a trava de duplo clique deixou de depender só do state
// `registering` (que só reflete o clique anterior a partir do próximo
// render) e passa a usar `lock`, um objeto mutável simples com
// `current` (mesmo formato de um useRef, mas passável como argumento
// puro para esta função ficar testável sem React). `lock.current` é
// lido/escrito de forma síncrona, antes de qualquer `await` — por isso
// permanece correto mesmo com duas chamadas síncronas no mesmo tick,
// sem esperar nenhum re-render. `registering` (state) continua existindo
// só para a UI (disabled/spinner) — ver useCommercialRegistration abaixo.
export async function runCommercialRegistration({ leadId, actionValue, lock, onRegisterInteraction, setRegistering, setError }) {
  if (lock.current) return undefined;
  lock.current = true;
  setRegistering(true);
  setError('');
  try {
    return await onRegisterInteraction(leadId, actionValue);
  } catch (e) {
    setError('Não foi possível registrar: ' + e.message);
    throw e;
  } finally {
    lock.current = false;
    setRegistering(false);
  }
}

// Fase 2D.1 — fio fino de useState por cima da orquestração pura acima.
// Extraído de LeadTimeline.handleRegister para ser reaproveitado também
// pelo picker de resultado de ligação em FollowUpQueue — sem duplicar o
// guard nem a chamada a registerCommercialInteraction em dois lugares.
// Deliberadamente sem UI específica de nenhum consumidor (o agrupamento
// de dois níveis + successFlash do LeadTimeline, ou o Atendeu/Não
// atendeu/Cancelar do FollowUpQueue ficam de fora de propósito).
//
// Fase 2D.1.2 — `registeringRef` é a trava operacional síncrona (nunca
// lida pela UI); `registering` (state) é só a representação visual do
// pending, continua pilotando o `disabled` dos botões como antes. API
// pública do hook (o objeto retornado) é idêntica à da Fase 2D.1 — zero
// mudança para LeadTimeline/FollowUpQueue.
export function useCommercialRegistration(onRegisterInteraction) {
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState('');
  const registeringRef = useRef(false);

  const register = useCallback(
    (leadId, actionValue) => runCommercialRegistration({ leadId, actionValue, lock: registeringRef, onRegisterInteraction, setRegistering, setError }),
    [onRegisterInteraction],
  );

  const clearError = useCallback(() => setError(''), []);

  return { registering, error, register, clearError };
}
