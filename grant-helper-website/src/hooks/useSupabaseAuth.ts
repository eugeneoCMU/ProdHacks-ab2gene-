import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../config/supabase';

export function isSupabaseConfigured(): boolean {
  return !!(
    import.meta.env.VITE_SUPABASE_URL?.trim() &&
    import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()
  );
}

export function useSupabaseAuth() {
  const configured = isSupabaseConfigured();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(() => configured);

  useEffect(() => {
    if (!configured) return;

    let mounted = true;

    supabase.auth.getSession().then(({ data: { session: s } }) => {
      if (!mounted) return;
      setSession(s);
      setLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, [configured]);

  return { session, loading, supabaseConfigured: configured };
}
