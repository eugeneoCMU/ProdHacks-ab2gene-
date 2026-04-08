import './Sidebar.css';

type NavItem = {
  id: string;
  label: string;
};

const navItems: NavItem[] = [
  { id: 'profile', label: 'Organization Profile' },
  { id: 'search', label: 'Find Grants' },
  { id: 'workspace', label: 'Grant Workspace' },
];

interface SidebarProps {
  activeView: string;
  onNavigate: (viewId: string) => void;
}

export default function Sidebar({ activeView, onNavigate }: SidebarProps) {
  return (
    <aside className="sidebar">
      <nav className="sidebar-nav">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={`nav-item ${activeView === item.id ? 'active' : ''}`}
            onClick={() => onNavigate(item.id)}
          >
            <span className="nav-label">{item.label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
