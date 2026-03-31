import { useEffect, useState } from 'react';
import { supabase } from '../../config/supabase';
import { isSupabaseConfigured } from '../../hooks/useSupabaseAuth';
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
  const [userOrg, setUserOrg] = useState<string>(() =>
    isSupabaseConfigured() ? '' : 'Demo'
  );

  useEffect(() => {
    if (!isSupabaseConfigured()) return;

    async function refreshLabel() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const meta = user?.user_metadata as { full_name?: string; organization_name?: string } | undefined;
      const label =
        meta?.organization_name ||
        meta?.full_name ||
        user?.email ||
        'Account';
      setUserOrg(label);
    }

    refreshLabel();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(() => {
      refreshLabel();
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleSignOut = async () => {
    if (!isSupabaseConfigured()) return;
    await supabase.auth.signOut();
  };

  return (
    <header className="topnav">
      <div className="topnav-content">
        <h2 className="topnav-title">{viewTitles[currentView] || 'GrantFlow'}</h2>

        <div className="topnav-actions">
          <button className="icon-button" title="Notifications">
            🔔
          </button>
          <button className="icon-button" title="Help">
            ❓
          </button>
          <div className="user-profile">
            <span className="user-name">{userOrg}</span>
            {isSupabaseConfigured() && (
              <button type="button" className="topnav-sign-out" onClick={handleSignOut}>
                Sign out
              </button>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
