import { useState, useEffect, useCallback, useRef } from 'react';
import { demoWorkspace } from './demo.js';

const KEY = 'piccinini-finance-preview-v1';
export function useFinance({ preview = false, enabled = true } = {}) {
  const [record, setRecord] = useState(null), [loading, setLoading] = useState(enabled), [saving, setSaving] = useState(false), [error, setError] = useState('');
  const lock = useRef(false), current = useRef(null);
  const load = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);setError('');
    try {
      let next;
      if (preview) {
        const saved = localStorage.getItem(KEY);
        next = saved ? JSON.parse(saved) : { revision: 0, data: demoWorkspace() };
        if (next.data?.schema !== 1) throw new Error('Dados de teste incompatíveis. Limpe os dados da preview.');
      } else {
        const { supabase } = await import('../lib/supabaseClient.js');
        const result = await supabase.from('crm_finance_workspace').select('*').eq('id', true).single();
        if (result.error) throw new Error('Financeiro ainda não habilitado no banco. A migração será aplicada após a aprovação da preview.');
        next = result.data;
      }
      current.current=next;setRecord(next);
    } catch (e) { setError(e.message); } finally {setLoading(false);}
  }, [preview, enabled]);
  useEffect(() => { load(); }, [load]);
  const commit = useCallback(async (transform, action = 'Atualização financeira') => {
    if (lock.current) throw new Error('Aguarde o salvamento em andamento.');
    if (!current.current) throw new Error('Recarregue os dados antes de salvar.');
    lock.current=true;setSaving(true);setError('');
    try {
      const base=current.current, data=transform(structuredClone(base.data));
      let next;
      if (preview) {
        const saved=localStorage.getItem(KEY);
        if (saved && JSON.parse(saved).revision!==base.revision) throw new Error('Outra aba alterou os dados. Recarregue antes de salvar.');
        next={revision:base.revision+1,data};localStorage.setItem(KEY,JSON.stringify(next));
      } else {
        const { supabase } = await import('../lib/supabaseClient.js');
        const result=await supabase.rpc('crm_save_finance_workspace',{expected_revision:base.revision,payload:data,action_label:action});
        if(result.error) throw result.error;next=Array.isArray(result.data)?result.data[0]:result.data;
        if(!next?.data)throw new Error('Resposta de persistência inválida. Recarregue antes de continuar.');
      }
      current.current=next;setRecord(next);return next;
    } catch(e) {setError(e.message);throw e;} finally {lock.current=false;setSaving(false);}
  },[preview]);
  const reset = async () => { if (!preview) return;localStorage.removeItem(KEY);await load(); };
  return { state:record?.data, revision:record?.revision, loading, saving, error, commit, reload:load, reset };
}
