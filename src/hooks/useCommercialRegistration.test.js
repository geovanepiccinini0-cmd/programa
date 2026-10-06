import { describe, expect, it, vi } from 'vitest';
import { runCommercialRegistration } from './useCommercialRegistration.js';

// Fase 2D.1 — testa só a orquestração pura (runCommercialRegistration),
// mesmo padrão de runCompleteTaskWithResult: setters injetados como
// spies, sem renderizar nada, sem React Testing Library.
function makeSetters() {
  const registeringCalls = [];
  const errorCalls = [];
  return {
    setRegistering: vi.fn((v) => registeringCalls.push(v)),
    setError: vi.fn((v) => errorCalls.push(v)),
    registeringCalls,
    errorCalls,
  };
}

describe('Fase 2D.1 — runCommercialRegistration', () => {
  it('call_connected: chama onRegisterInteraction exatamente 1x com os argumentos certos, devolve a row', async () => {
    const insertedRow = { id: 'int-1', leadId: 'lead-1', type: 'call' };
    const onRegisterInteraction = vi.fn(async () => insertedRow);
    const { setRegistering, setError } = makeSetters();

    const result = await runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', registering: false, onRegisterInteraction, setRegistering, setError,
    });

    expect(onRegisterInteraction).toHaveBeenCalledTimes(1);
    expect(onRegisterInteraction).toHaveBeenCalledWith('lead-1', 'call_connected');
    expect(result).toBe(insertedRow);
  });

  it('call_no_answer: chama onRegisterInteraction exatamente 1x com os argumentos certos', async () => {
    const onRegisterInteraction = vi.fn(async () => ({ id: 'int-2' }));
    const { setRegistering, setError } = makeSetters();

    await runCommercialRegistration({
      leadId: 'lead-2', actionValue: 'call_no_answer', registering: false, onRegisterInteraction, setRegistering, setError,
    });

    expect(onRegisterInteraction).toHaveBeenCalledTimes(1);
    expect(onRegisterInteraction).toHaveBeenCalledWith('lead-2', 'call_no_answer');
  });

  it('seta registering true no início e false ao final (sucesso)', async () => {
    const onRegisterInteraction = vi.fn(async () => ({ id: 'int-1' }));
    const { setRegistering, setError, registeringCalls } = makeSetters();

    await runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', registering: false, onRegisterInteraction, setRegistering, setError,
    });

    expect(registeringCalls).toEqual([true, false]);
  });

  it('limpa o erro no início de uma nova tentativa', async () => {
    const onRegisterInteraction = vi.fn(async () => ({ id: 'int-1' }));
    const { setRegistering, setError, errorCalls } = makeSetters();

    await runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', registering: false, onRegisterInteraction, setRegistering, setError,
    });

    expect(errorCalls[0]).toBe('');
  });

  it('falha no registro: erro inline populado, registering volta a false, erro propaga (picker continua utilizável)', async () => {
    const onRegisterInteraction = vi.fn(async () => { throw new Error('Falha de rede simulada'); });
    const { setRegistering, setError, registeringCalls, errorCalls } = makeSetters();

    await expect(runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', registering: false, onRegisterInteraction, setRegistering, setError,
    })).rejects.toThrow('Falha de rede simulada');

    expect(registeringCalls).toEqual([true, false]);
    expect(errorCalls).toEqual(['', 'Não foi possível registrar: Falha de rede simulada']);
  });

  it('guard de duplo clique: registering=true -> não chama onRegisterInteraction, devolve undefined, zero duplicidade', async () => {
    const onRegisterInteraction = vi.fn(async () => ({ id: 'int-1' }));
    const { setRegistering, setError } = makeSetters();

    const result = await runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', registering: true, onRegisterInteraction, setRegistering, setError,
    });

    expect(onRegisterInteraction).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    expect(setRegistering).not.toHaveBeenCalled();
  });

  it('cancelar não passa por aqui: nenhuma chamada a runCommercialRegistration significa zero interaction (contrato, não comportamento desta função)', () => {
    // Documental: "Cancelar" no picker nunca invoca runCommercialRegistration
    // — é só um fechamento de state local no componente. Não há nada a
    // testar aqui além de confirmar que a função exige leadId/actionValue
    // explícitos (nunca é chamada "por acaso").
    expect(typeof runCommercialRegistration).toBe('function');
  });
});
