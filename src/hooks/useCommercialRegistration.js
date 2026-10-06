import { useCallback, useState } from 'react';

// Fase 2D.1 — orquestração pura (testável sem renderizar nada, mesmo
// padrão de runCompleteTaskWithResult em useAppState.js): guard de duplo
// clique + chamada a onRegisterInteraction + aplicação do resultado via
// os setters injetados. Nunca decide UI — isso fica por conta de quem
// chama (LeadTimeline, ou o picker de ligação de FollowUpQueue.jsx).
export async function runCommercialRegistration({ leadId, actionValue, registering, onRegisterInteraction, setRegistering, setError }) {
  if (registering) return undefined;
  setRegistering(true);
  setError('');
  try {
    return await onRegisterInteraction(leadId, actionValue);
  } catch (e) {
    setError('Não foi possível registrar: ' + e.message);
    throw e;
  } finally {
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
export function useCommercialRegistration(onRegisterInteraction) {
  const [registering, setRegistering] = useState(false);
  const [error, setError] = useState('');

  const register = useCallback(
    (leadId, actionValue) => runCommercialRegistration({ leadId, actionValue, registering, onRegisterInteraction, setRegistering, setError }),
    [registering, onRegisterInteraction],
  );

  const clearError = useCallback(() => setError(''), []);

  return { registering, error, register, clearError };
}
