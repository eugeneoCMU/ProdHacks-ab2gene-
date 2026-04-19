import { useState } from 'react';
import { isSupabaseConfigured, supabase } from '../../config/supabase';
import './EmptyState.css';

const DEMO_FORM_URL = 'https://rdtrbdeo.paperform.co/';

const PROFILE_STORAGE_KEY = 'grantflow.organizationProfile';

interface WorkspaceViewProps {
  /** Optional. When set and Supabase has document_chunks for this user, they are used as context for Gemini. */
  userId?: string;
}

export default function WorkspaceView({ userId }: WorkspaceViewProps) {
  const organizationProfile = (typeof window !== 'undefined' ? window.localStorage.getItem(PROFILE_STORAGE_KEY) : '') || '';
  const [showDemoBox, setShowDemoBox] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreateNewApplication = () => {
    setError(null);
    setShowDemoBox(true);
  };

  const handleGenerateAndOpenForm = async () => {
    setError(null);
    setLoading(true);
    try {
      let resolvedUserId = userId;
      if (!resolvedUserId && isSupabaseConfigured && supabase) {
        const { data: { session } } = await supabase.auth.getSession();
        resolvedUserId = session?.user?.id ?? undefined;
      }

      if (!organizationProfile.trim() && !resolvedUserId) {
        throw new Error('Upload or sync organization documents before opening the demo form.');
      }

      window.open(DEMO_FORM_URL, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate application');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="empty-state">
      <div className="empty-state-icon">✍️</div>
      <h2 className="empty-state-title">Your AI-Powered Grant Writing Workspace</h2>
      <p className="empty-state-description">
        Draft, refine, and perfect your grant applications with AI assistance.
        Answer key questions and let our AI help you craft compelling narratives
        that resonate with funders.
      </p>
      <div className="empty-state-actions">
        <button
          className="btn-primary"
          onClick={handleCreateNewApplication}
        >
          Create New Application
        </button>
        {/* <button className="btn-secondary">View Templates</button> */}
      </div>
      {showDemoBox && (
        <div className="demo-grant-box" style={{ marginTop: 20, padding: 20, border: '1px solid #e5e7eb', borderRadius: 12, backgroundColor: '#f9fafb', maxWidth: 400 }}>
          <p style={{ margin: '0 0 12px 0', fontWeight: 600, color: '#1f2937' }}>Paperform demo grant</p>
          <button
            type="button"
            className="btn-primary"
            onClick={handleGenerateAndOpenForm}
            disabled={loading}
          >
            {loading ? 'Generating answers…' : 'Generate answers & open form'}
          </button>
        </div>
      )}
      {error && (
        <p className="upload-error" role="alert" style={{ marginTop: 12 }}>
          {error}
        </p>
      )}

      <div className="feature-grid">
        <div className="feature-card">
          <div className="feature-icon">✨</div>
          <h3 className="feature-title">AI Draft Generation</h3>
          <p className="feature-text">
            Answer questions about your project and get AI-generated draft responses.
          </p>
        </div>
        <div className="feature-card">
          <div className="feature-icon">🔄</div>
          <h3 className="feature-title">Iterative Refinement</h3>
          <p className="feature-text">
            Edit and refine AI suggestions to match your organization's voice.
          </p>
        </div>
        <div className="feature-card">
          <div className="feature-icon">📝</div>
          <h3 className="feature-title">Version Control</h3>
          <p className="feature-text">
            Track changes and maintain different versions of your applications.
          </p>
        </div>
      </div>
    </div>
  );
}
