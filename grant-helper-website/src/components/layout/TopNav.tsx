import { useEffect, useState } from 'react';
import { isSupabaseConfigured, supabase } from '../../config/supabase';
import './TopNav.css';

interface TopNavProps {
  currentView: string;
  onNavigate: (viewId: string) => void;
}

const viewTitles: Record<string, string> = {
  profile: 'Organization Profile',
  search: 'Find Grants',
  workspace: 'Grant Workspace',
};

export default function TopNav({ currentView, onNavigate }: TopNavProps) {
  const [sessionLabel, setSessionLabel] = useState('Not connected');
  const [sessionReady, setSessionReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showAuthPanel, setShowAuthPanel] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authMessage, setAuthMessage] = useState('');

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setSessionLabel('Auth unavailable');
      setSessionReady(false);
      return;
    }

    const client = supabase;
    let mounted = true;

    const syncSession = async () => {
      try {
        const {
          data: { session },
        } = await client.auth.getSession();
        if (!mounted) return;
        const userId = session?.user?.id || '';
        if (userId) {
          localStorage.setItem('grantflow.userId', userId);
          setSessionLabel(`Connected · ${userId.slice(0, 6)}`);
          setSessionReady(true);
        } else {
          localStorage.removeItem('grantflow.userId');
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
        localStorage.setItem('grantflow.userId', userId);
        setSessionLabel(`Connected · ${userId.slice(0, 6)}`);
        setSessionReady(true);
      } else {
        localStorage.removeItem('grantflow.userId');
        setSessionLabel('Not connected');
        setSessionReady(false);
      }
    });

    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  const openAuthPanel = () => {
    setShowAuthPanel(true);
    setAuthMode('login');
    setAuthMessage('');
    onNavigate('profile');
  };

  const closeAuthPanel = () => {
    if (busy) return;
    setShowAuthPanel(false);
  };

  const handleAuthSubmit = async () => {
    if (!isSupabaseConfigured || !supabase) {
      setAuthMessage('Supabase auth is not configured in this local environment yet.');
      return;
    }

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setAuthMessage('Enter both your email and password to continue.');
      return;
    }

    setBusy(true);
    setAuthMessage('');

    try {
      const { data, error } =
        authMode === 'login'
          ? await supabase.auth.signInWithPassword({
              email: trimmedEmail,
              password,
            })
          : await supabase.auth.signUp({
              email: trimmedEmail,
              password,
            });

      if (error) {
        setAuthMessage(error.message);
        return;
      }

      const userId = data.user?.id || data.session?.user?.id || '';
      if (userId) {
        localStorage.setItem('grantflow.userId', userId);
        setSessionLabel(`Connected · ${userId.slice(0, 6)}`);
        setSessionReady(true);
        setShowAuthPanel(false);
        setEmail('');
        setPassword('');
        setAuthMessage('');
        onNavigate('profile');
        return;
      }

      if (authMode === 'signup') {
        setAuthMessage('Account created. Check your email if confirmation is enabled, then log in.');
        setAuthMode('login');
        setPassword('');
        return;
      }

      setAuthMessage('Login succeeded, but no active session was returned.');
    } catch {
      setAuthMessage(authMode === 'login' ? 'Login failed. Try again.' : 'Sign up failed. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = async () => {
    if (!supabase) {
      setSessionLabel('Auth unavailable');
      setSessionReady(false);
      localStorage.removeItem('grantflow.userId');
      return;
    }

    setBusy(true);
    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        setSessionLabel('Logout failed');
        return;
      }
      localStorage.removeItem('grantflow.userId');
      setSessionLabel('Not connected');
      setSessionReady(false);
      setAuthMessage('');
    } catch {
      setSessionLabel('Logout failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="topnav">
        <div className="topnav-content">
          <div className="topnav-brand">
            <p className="topnav-eyebrow">Grant workflow system</p>
            <h2 className="topnav-title">GrantFlow</h2>
          </div>

          <div className="topnav-actions">
            <div className={`auth-status ${sessionReady ? 'auth-status--connected' : ''}`}>
              <div className="auth-status-copy">
                <span className="auth-status-label">{sessionReady ? 'Account' : 'Document sync'}</span>
                <span className="auth-status-value">
                  {sessionReady
                    ? sessionLabel
                    : isSupabaseConfigured
                      ? 'Log in to keep uploads tied to your account'
                      : 'Supabase auth needs valid environment keys'}
                </span>
              </div>
              {!sessionReady ? (
                <button
                  type="button"
                  className="auth-status-button"
                  onClick={openAuthPanel}
                  aria-label="Open sign in panel"
                >
                  Log in
                </button>
              ) : (
                <button
                  type="button"
                  className="auth-status-button auth-status-button--secondary"
                  onClick={handleLogout}
                  disabled={busy}
                  aria-label="Log out of your account"
                >
                  {busy ? 'Logging out...' : 'Log out'}
                </button>
              )}
            </div>
            <div className="topnav-meta">{viewTitles[currentView] || 'Workspace'}</div>
          </div>
        </div>
      </header>

      {showAuthPanel && (
        <div className="auth-modal-shell" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">
          <button
            type="button"
            className="auth-modal-backdrop"
            aria-label="Close sign in panel"
            onClick={closeAuthPanel}
          />
          <div className="auth-modal">
            <div className="auth-modal-intro">
              <p className="auth-modal-kicker">GrantFlow account</p>
              <h3 id="auth-modal-title" className="auth-modal-title">
                {authMode === 'login' ? 'Welcome back' : 'Create your account'}
              </h3>
              <p className="auth-modal-description">
                {authMode === 'login'
                  ? 'Log in to keep uploaded documents, search context, and workspace answers attached to one organization account.'
                  : 'Create an account so your team can keep document uploads and grant context synced across sessions.'}
              </p>
              <ul className="auth-modal-benefits">
                <li>Keep uploaded files tied to one organization</li>
                <li>Reuse the same profile across search and drafting</li>
                <li>Pick up your workspace from any signed-in session</li>
              </ul>
            </div>

            <div className="auth-modal-card">
              <div className="auth-modal-card-header">
                <div className="auth-modal-mode-toggle" role="tablist" aria-label="Authentication mode">
                  <button
                    type="button"
                    className={`auth-modal-mode ${authMode === 'login' ? 'auth-modal-mode--active' : ''}`}
                    onClick={() => {
                      setAuthMode('login');
                      setAuthMessage('');
                    }}
                  >
                    Log in
                  </button>
                  <button
                    type="button"
                    className={`auth-modal-mode ${authMode === 'signup' ? 'auth-modal-mode--active' : ''}`}
                    onClick={() => {
                      setAuthMode('signup');
                      setAuthMessage('');
                    }}
                  >
                    Create account
                  </button>
                </div>
                <p className="auth-modal-note">
                  {isSupabaseConfigured
                    ? 'Use your organization email so saved documents and profile context stay with the right account.'
                    : 'Authentication is disabled until valid Supabase keys are present in .env.'}
                </p>
              </div>

              <div className="auth-modal-fieldset">
                <label className="auth-modal-field">
                  <span>Email</span>
                  <input
                    type="email"
                    placeholder="name@organization.org"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </label>
                <label className="auth-modal-field">
                  <span>Password</span>
                  <input
                    type="password"
                    placeholder="••••••••"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </label>
              </div>

              {authMessage && <p className="auth-modal-feedback">{authMessage}</p>}

              <button
                type="button"
                className="auth-modal-primary"
                onClick={handleAuthSubmit}
                disabled={busy}
              >
                {busy
                  ? authMode === 'login'
                    ? 'Logging in...'
                    : 'Creating account...'
                  : authMode === 'login'
                    ? 'Log in'
                    : 'Create account'}
              </button>

              <button
                type="button"
                className="auth-modal-secondary"
                onClick={closeAuthPanel}
                disabled={busy}
              >
                Maybe later
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
