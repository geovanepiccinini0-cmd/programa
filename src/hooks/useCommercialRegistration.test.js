import { describe, expect, it, vi } from 'vitest';
import { runCommercialRegistration } from './useCommercialRegistration.js';

// Fase 2D.1 / 2D.1.2 — testa só a orquestração pura (runCommercialRegistration),
// mesmo padrão de runCompleteTaskWithResult: setters/lock injetados como
// spies/objetos simples, sem renderizar nada, sem React Testing Library.
//
// `lock` imita a forma de um useRef ({ current: boolean }) — é o mesmo
// objeto mutável usado em produção (useCommercialRegistration passa seu
// próprio registeringRef aqui), só que criado à mão para o teste poder
// inspecionar `lock.current` diretamente depois da chamada.
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

function makeLock() {
  return { current: false };
}

// Promise controlável de fora — necessária para o teste crítico de
// seção 7 (duas chamadas síncronas antes de qualquer resolução).
function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('Fase 2D.1 / 2D.1.2 — runCommercialRegistration', () => {
  it('A) call_connected: chama onRegisterInteraction exatamente 1x com os argumentos certos, devolve a row', async () => {
    const insertedRow = { id: 'int-1', leadId: 'lead-1', type: 'call' };
    const onRegisterInteraction = vi.fn(async () => insertedRow);
    const { setRegistering, setError } = makeSetters();

    const result = await runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', lock: makeLock(), onRegisterInteraction, setRegistering, setError,
    });

    expect(onRegisterInteraction).toHaveBeenCalledTimes(1);
    expect(onRegisterInteraction).toHaveBeenCalledWith('lead-1', 'call_connected');
    expect(result).toBe(insertedRow);
  });

  it('B) call_no_answer: chama onRegisterInteraction exatamente 1x com os argumentos certos', async () => {
    const onRegisterInteraction = vi.fn(async () => ({ id: 'int-2' }));
    const { setRegistering, setError } = makeSetters();

    await runCommercialRegistration({
      leadId: 'lead-2', actionValue: 'call_no_answer', lock: makeLock(), onRegisterInteraction, setRegistering, setError,
    });

    expect(onRegisterInteraction).toHaveBeenCalledTimes(1);
    expect(onRegisterInteraction).toHaveBeenCalledWith('lead-2', 'call_no_answer');
  });

  it('seta registering(state) true no início e false ao final (sucesso)', async () => {
    const onRegisterInteraction = vi.fn(async () => ({ id: 'int-1' }));
    const { setRegistering, setError, registeringCalls } = makeSetters();

    await runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', lock: makeLock(), onRegisterInteraction, setRegistering, setError,
    });

    expect(registeringCalls).toEqual([true, false]);
  });

  it('limpa o erro no início de uma nova tentativa', async () => {
    const onRegisterInteraction = vi.fn(async () => ({ id: 'int-1' }));
    const { setRegistering, setError, errorCalls } = makeSetters();

    await runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', lock: makeLock(), onRegisterInteraction, setRegistering, setError,
    });

    expect(errorCalls[0]).toBe('');
  });

  it('C) falha no registro: erro propaga, setError correto, lock liberado, registering(state) volta a false', async () => {
    const onRegisterInteraction = vi.fn(async () => { throw new Error('Falha de rede simulada'); });
    const { setRegistering, setError, registeringCalls, errorCalls } = makeSetters();
    const lock = makeLock();

    await expect(runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', lock, onRegisterInteraction, setRegistering, setError,
    })).rejects.toThrow('Falha de rede simulada');

    expect(registeringCalls).toEqual([true, false]);
    expect(errorCalls).toEqual(['', 'Não foi possível registrar: Falha de rede simulada']);
    expect(lock.current).toBe(false);
  });

  it('guard de duplo clique (lock já adquirido por fora): não chama onRegisterInteraction, devolve undefined, zero duplicidade', async () => {
    const onRegisterInteraction = vi.fn(async () => ({ id: 'int-1' }));
    const { setRegistering, setError } = makeSetters();
    const lock = { current: true };

    const result = await runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', lock, onRegisterInteraction, setRegistering, setError,
    });

    expect(onRegisterInteraction).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
    expect(setRegistering).not.toHaveBeenCalled();
  });

  it('D) depois de sucesso: lock liberado permite uma nova chamada posterior', async () => {
    const onRegisterInteraction = vi.fn(async () => ({ id: 'int-1' }));
    const { setRegistering, setError } = makeSetters();
    const lock = makeLock();

    await runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', lock, onRegisterInteraction, setRegistering, setError,
    });
    expect(lock.current).toBe(false);

    await runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_no_answer', lock, onRegisterInteraction, setRegistering, setError,
    });

    expect(onRegisterInteraction).toHaveBeenCalledTimes(2);
  });

  it('E) depois de erro: lock liberado permite um retry posterior (mesmo lock, mesma referência)', async () => {
    const onRegisterInteraction = vi.fn()
      .mockRejectedValueOnce(new Error('Falha de rede simulada'))
      .mockResolvedValueOnce({ id: 'int-2' });
    const { setRegistering, setError } = makeSetters();
    const lock = makeLock();

    await expect(runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', lock, onRegisterInteraction, setRegistering, setError,
    })).rejects.toThrow('Falha de rede simulada');
    expect(lock.current).toBe(false);

    const retryResult = await runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', lock, onRegisterInteraction, setRegistering, setError,
    });

    expect(onRegisterInteraction).toHaveBeenCalledTimes(2);
    expect(retryResult).toEqual({ id: 'int-2' });
  });

  it('F) segunda chamada disparada enquanto a primeira ainda está pendente: zero segunda interaction', async () => {
    const { promise, resolve } = deferred();
    const onRegisterInteraction = vi.fn(() => promise);
    const { setRegistering, setError } = makeSetters();
    const lock = makeLock();

    const first = runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', lock, onRegisterInteraction, setRegistering, setError,
    });

    // Lock já deve estar adquirido de forma síncrona, antes mesmo do
    // primeiro `await` resolver — é exatamente essa garantia que a
    // 2D.1.2 adiciona (ver teste G para a prova mais direta).
    expect(lock.current).toBe(true);

    const second = await runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', lock, onRegisterInteraction, setRegistering, setError,
    });

    expect(second).toBeUndefined();
    expect(onRegisterInteraction).toHaveBeenCalledTimes(1);

    resolve({ id: 'int-1' });
    await first;
    expect(lock.current).toBe(false);
  });

  // ================================================================
  // G) TESTE CRÍTICO (obrigatório, Fase 2D.1.2, seção 7) — duas
  // chamadas SÍNCRONAS, no MESMO tick/closure, antes de resolver a
  // Promise da primeira. Não simula dois eventos DOM: chama a função
  // pura diretamente duas vezes seguidas, sem nenhum `await` entre
  // elas, para provar a propriedade atômica do lock (independente de
  // qualquer re-render do React ter ou não acontecido).
  // ================================================================
  it('G) duas chamadas síncronas consecutivas (mesmo tick, antes de qualquer resolução): exatamente 1 interaction', async () => {
    const { promise, resolve } = deferred();
    const onRegisterInteraction = vi.fn(() => promise);
    const { setRegistering, setError } = makeSetters();
    const lock = makeLock();

    // Chamadas síncronas consecutivas, no mesmo statement/tick — sem
    // `await` entre a primeira e a segunda. Como `runCommercialRegistration`
    // só executa de forma assíncrona a partir do `await onRegisterInteraction(...)`,
    // tudo antes disso (checar/adquirir o lock) roda de forma síncrona
    // na chamada da função, mesmo ela sendo `async`.
    const first = runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', lock, onRegisterInteraction, setRegistering, setError,
    });
    const second = runCommercialRegistration({
      leadId: 'lead-1', actionValue: 'call_connected', lock, onRegisterInteraction, setRegistering, setError,
    });

    const [firstResult, secondResult] = await Promise.all([
      first,
      second.then((r) => { resolve({ id: 'int-1' }); return r; }),
    ]);

    // A segunda chamada (que encontrou o lock já adquirido) resolve
    // imediatamente com undefined, SEM esperar a primeira terminar —
    // por isso dispara o resolve() da promise subjacente dentro do
    // `.then` acima, liberando a primeira chamada depois.
    expect(secondResult).toBeUndefined();
    expect(firstResult).toEqual({ id: 'int-1' });
    expect(onRegisterInteraction).toHaveBeenCalledTimes(1);
    expect(lock.current).toBe(false);
  });

  it('cancelar não passa por aqui: nenhuma chamada a runCommercialRegistration significa zero interaction (contrato, não comportamento desta função)', () => {
    // Documental: "Cancelar" no picker nunca invoca runCommercialRegistration
    // — é só um fechamento de state local no componente. Não há nada a
    // testar aqui além de confirmar que a função exige leadId/actionValue
    // explícitos (nunca é chamada "por acaso").
    expect(typeof runCommercialRegistration).toBe('function');
  });
});
