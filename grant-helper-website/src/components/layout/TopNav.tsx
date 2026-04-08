import { useEffect, useState } from 'react';
import { isSupabaseConfigured, supabase } from '../../config/supabase';
import './TopNav.css';

interface TopNavProps {
  currentView: string;
}

const viewTitles: Record<string, string> = {
  profile: 'Organization Profile',
  search: 'Find Grants',
  workspace: 'Grant Workspace',
};

export default function TopNav({ currentView }: TopNavProps) {
  const [sessionLabel, setSessionLabel] = useState('Not connected');
  const [sessionReady, setSessionReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setSessionLabel('Local mode');
      setSessionReady(false);
      return;
    }

    const client = supabase;
    let mounted = true;

    const syncSession = async () => {
      try {
        const { data: { session } } = await client.auth.getSession();
        if (!mounted) return;
        const userId = session?.user?.id || '';
        if (userId) {
          setSessionLabel(`Connected · ${userId.slice(0, 6)}`);
          setSessionReady(true);
        } else {
          setSessionLabel('Not connected');
          setSessionReady(false);
        }
      } catch {
        if (!mounted) return;
        setSessionLabel('Auth unavailable');
        setSessionReady(false);
      }
    };

    syncSession();

    const { data: subscription } = client.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      const userId = session?.user?.id || '';
      if (userId) {
        setSessionLabel(`Connected · ${userId.slice(0, 6)}`);
        setSessionReady(true);
      } else {
        setSessionLabel('Not connected');
        setSessionReady(false);
      }
    });

    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const handleConnect = async () => {
    if (!isSupabaseConfigured || !supabase) {
      setSessionLabel('Supabase not configured');
      return;
    }

    setBusy(true);
    try {
      const { error } = await supabase.auth.signInAnonymously();
      if (error) {
        setSessionLabel('Connection failed');
        return;
      }
      const { data: { session } } = await supabase.auth.getSession();
      const userId = session?.user?.id || '';
      if (userId) {
        localStorage.setItem('grantflow.userId', userId);
        setSessionLabel(`Connected · ${userId.slice(0, 6)}`);
        setSessionReady(true);
      }
    } catch {
      setSessionLabel('Connection failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="topnav">
      <div className="topnav-content">
        <div className="topnav-brand">
          <p className="topnav-eyebrow">Grant workflow system</p>
          <h2 className="topnav-title">GrantFlow</h2>
        </div>

        <div className="topnav-actions">
          <div className={`auth-status ${sessionReady ? 'auth-status--connected' : ''}`}>
            <div className="auth-status-copy">
              <span className="auth-status-label">{sessionReady ? 'Account' : 'Sign in to sync documents'}</span>
              <span className="auth-status-value">{sessionLabel}</span>
            </div>
            {!sessionReady && (
              <button
                type="button"
                className="auth-status-button"
                onClick={handleConnect}
                disabled={busy}
                aria-label="Connect your account"
              >
                {busy ? 'Connecting...' : 'Sign in / Connect'}
              </button>
            )}
          </div>
          <div className="topnav-meta">{viewTitles[currentView] || 'Workspace'}</div>
        </div>
      </div>
    </header>
  );
}
