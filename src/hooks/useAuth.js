import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { profilesApi } from '../lib/db.js';

export function useAuth() {
  const [session, setSession] = useState(undefined); // undefined = carregando, null = deslogado
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    if (!supabase) { setSession(null); return; }
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setIsAdmin(false); return; }
    let cancelled = false;
    profilesApi.fetchMine(session.user.id)
      .then((profile) => { if (!cancelled) setIsAdmin(Boolean(profile?.isAdmin)); })
      .catch(() => { if (!cancelled) setIsAdmin(false); });
    return () => { cancelled = true; };
  }, [session]);

  async function signIn(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  return {
    session,
    loading: session === undefined,
    userId: session ? session.user.id : null,
    isAdmin,
    signIn,
    signOut,
  };
}
