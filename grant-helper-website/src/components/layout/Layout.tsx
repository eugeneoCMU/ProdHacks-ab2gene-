import { type ReactNode } from 'react';
import Sidebar from './Sidebar';
import TopNav from './TopNav';
import './Layout.css';

interface LayoutProps {
  children: ReactNode;
  activeView: string;
  onNavigate: (viewId: string) => void;
}

export default function Layout({ children, activeView, onNavigate }: LayoutProps) {
  return (
    <div className="app-layout">
      <TopNav currentView={activeView} />
      <div className="main-container">
        <Sidebar activeView={activeView} onNavigate={onNavigate} />
        <main className="content-area">
          {children}
        </main>
      </div>
    </div>
  );
}
