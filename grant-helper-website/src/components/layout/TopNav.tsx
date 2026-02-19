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
            <div className="user-avatar">S</div>
            <span className="user-name">Sarah's Org</span>
          </div>
        </div>
      </div>
    </header>
  );
}
