import './Sidebar.css';

type NavItem = {
  id: string;
  label: string;
  icon: string;
};

const navItems: NavItem[] = [
  { id: 'profile', label: 'Organization Profile', icon: '🏢' },
  { id: 'search', label: 'Find Grants', icon: '🔍' },
  { id: 'workspace', label: 'Grant Workspace', icon: '✍️' },
];

interface SidebarProps {
  activeView: string;
  onNavigate: (viewId: string) => void;
}

export default function Sidebar({ activeView, onNavigate }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1 className="sidebar-logo">💡 GrantFlow</h1>
        <p className="sidebar-tagline">AI-Powered Grant Writing</p>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${activeView === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <p className="footer-text">Built for nonprofits 💚</p>
      </div>
    </aside>
  );
}
