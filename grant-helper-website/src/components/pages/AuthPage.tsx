import { useState } from 'react';
import { supabase } from '../../config/supabase';
import './AuthPage.css';

type Mode = 'login' | 'register' | 'forgot';

export default function AuthPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [organizationName, setOrganizationName] = useState('');
  const [fullName, setFullName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resetFeedback = () => {
    setMessage(null);
    setError(null);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    resetFeedback();
    setSubmitting(true);
    try {
      const { error: signErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signErr) {
        setError(signErr.message);
        return;
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    resetFeedback();
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      setError('Please enter your email address.');
      return;
    }
    setSubmitting(true);
    try {
      const { error: resetErr } = await supabase.auth.resetPasswordForEmail(trimmedEmail, {
        redirectTo: `${window.location.origin}`,
      });
      if (resetErr) {
        setError(resetErr.message);
        return;
      }
      setMessage('Password reset link sent. Check your email.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    resetFeedback();
    const org = organizationName.trim();
    if (!org) {
      setError('Organization name is required.');
      return;
    }
    setSubmitting(true);
    try {
      const { data, error: signErr } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            organization_name: org,
            full_name: fullName.trim() || undefined,
          },
        },
      });
      if (signErr) {
        setError(signErr.message);
        return;
      }
      if (data.session) {
        setMessage('Account created. You are signed in.');
      } else {
        setMessage(
          'Check your email to confirm your address. Your organization profile will be ready after you verify.'
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="auth-brand-icon">🏢</span>
          <h1 className="auth-brand-title">GrantFlow</h1>
          <p className="auth-brand-sub">Sign in to manage your nonprofit profile and grants.</p>
        </div>

        {mode !== 'forgot' && (
          <div className="auth-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={`auth-tab ${mode === 'login' ? 'active' : ''}`}
              onClick={() => {
                setMode('login');
                resetFeedback();
              }}
            >
              Log in
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={`auth-tab ${mode === 'register' ? 'active' : ''}`}
              onClick={() => {
                setMode('register');
                resetFeedback();
              }}
            >
              Register
            </button>
          </div>
        )}

        {mode === 'login' ? (
          <form className="auth-form" onSubmit={handleLogin}>
            <label className="auth-label">
              Email
              <input
                className="auth-input"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label className="auth-label">
              Password
              <input
                className="auth-input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
            </label>
            {error && (
              <p className="auth-error" role="alert">
                {error}
              </p>
            )}
            <button className="btn-primary auth-submit" type="submit" disabled={submitting}>
              {submitting ? 'Signing in…' : 'Log in'}
            </button>
            <button
              type="button"
              className="auth-forgot-link"
              onClick={() => { setMode('forgot'); resetFeedback(); }}
            >
              Forgot your password?
            </button>
          </form>
        ) : mode === 'forgot' ? (
          <form className="auth-form" onSubmit={handleForgotPassword}>
            <p className="auth-forgot-description">
              Enter your email and we'll send you a link to reset your password.
            </p>
            <label className="auth-label">
              Email
              <input
                className="auth-input"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            {error && (
              <p className="auth-error" role="alert">
                {error}
              </p>
            )}
            {message && (
              <p className="auth-message" role="status">
                {message}
              </p>
            )}
            <button className="btn-primary auth-submit" type="submit" disabled={submitting}>
              {submitting ? 'Sending…' : 'Send reset link'}
            </button>
            <button
              type="button"
              className="auth-forgot-link"
              onClick={() => { setMode('login'); resetFeedback(); }}
            >
              Back to log in
            </button>
          </form>
        ) : (
          <form className="auth-form" onSubmit={handleRegister}>
            <label className="auth-label">
              Organization name
              <input
                className="auth-input"
                type="text"
                autoComplete="organization"
                value={organizationName}
                onChange={(e) => setOrganizationName(e.target.value)}
                required
                placeholder="e.g. Community Arts Collective"
              />
            </label>
            <label className="auth-label">
              Your name <span className="auth-optional">(optional)</span>
              <input
                className="auth-input"
                type="text"
                autoComplete="name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="For your account"
              />
            </label>
            <label className="auth-label">
              Email
              <input
                className="auth-input"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label className="auth-label">
              Password
              <input
                className="auth-input"
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={6}
              />
            </label>
            {error && (
              <p className="auth-error" role="alert">
                {error}
              </p>
            )}
            {message && (
              <p className="auth-message" role="status">
                {message}
              </p>
            )}
            <button className="btn-primary auth-submit" type="submit" disabled={submitting}>
              {submitting ? 'Creating account…' : 'Create organization account'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
