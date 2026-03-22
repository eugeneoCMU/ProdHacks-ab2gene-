import { useState } from 'react';
import { supabase } from '../../config/supabase';
import './EmptyState.css';

/**
 * Demo: Manually enter your Google Form ID and entry IDs here.
 * - Form ID: from the form URL .../d/e/FORM_ID/viewform
 * - Entry IDs: from "prefill" link when editing the form, or from the form's HTML (name="entry.XXXXX")
 * - Questions: used by Gemini to generate answers; keys must match GOOGLE_FORM_ENTRY_IDS.
 */
const GOOGLE_FORM_ID = '1FAIpQLSeqewu_zjiu7TnUiAyRCT57i9lkeRbALArLXi6DdO43OhL5Wg';
const GOOGLE_FORM_ENTRY_IDS: Record<string, string> = {
  impact: 'entry.216607139',
  use_of_funds: 'entry.1232879177',
  problem_solution: 'entry.76808297',
  goal: 'entry.344212770',
};

const GOOGLE_FORM_QUESTIONS: Record<string, string> = {
  impact: "Please detail your organization's measurable impact over the last 12 months. Provide specific metrics on the demographics and total number of individuals served by your primary program. (Max 200 words)",
  use_of_funds: "If awarded this $15,000 grant, exactly how will the funds be allocated? Please explain how this aligns with your current operating budget and historical funding. (Max 250 words).",
  problem_solution: "Describe the specific community need your program addresses. How does your methodology uniquely solve this problem compared to other existing services in the area? (Max 300 words).",
  goal: "Funding is not guaranteed in perpetuity. What is your organization's long-term sustainability plan to continue this program after this grant period ends? (Max 150 words).",
};

interface WorkspaceViewProps {
  organizationProfile?: string;
  /** Optional. When set and Supabase has document_chunks for this user, they are used as context for Gemini. */
  userId?: string;
}

export default function WorkspaceView({ organizationProfile = '', userId }: WorkspaceViewProps) {
  const [showDemoBox, setShowDemoBox] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreateNewApplication = () => {
    setError(null);
    setShowDemoBox(true);
  };

  const handleGenerateAndOpenForm = async () => {
    if (!GOOGLE_FORM_ID?.trim()) {
      setError('Please set GOOGLE_FORM_ID in WorkspaceView.tsx for this demo.');
      return;
    }
    setError(null);
    setLoading(true);
    try {
      let resolvedUserId = userId;
      if (!resolvedUserId) {
        const { data: { session } } = await supabase.auth.getSession();
        resolvedUserId = session?.user?.id ?? undefined;
      }

      const res = await fetch('/api/google-form/prefill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          formId: GOOGLE_FORM_ID,
          organizationProfile: organizationProfile || undefined,
          entryIds: GOOGLE_FORM_ENTRY_IDS,
          questions: GOOGLE_FORM_QUESTIONS,
          ...(resolvedUserId ? { userId: resolvedUserId } : {}),
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `Request failed: ${res.status}`);
      }

      const { url, answers } = (await res.json()) as { url?: string; answers?: Record<string, string> };
      if (!url) throw new Error('No pre-fill URL returned');

      if (answers) {
        console.log('Generated answers:', answers);
      }

      window.open(url, '_blank', 'noopener,noreferrer');
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
          <p style={{ margin: '0 0 12px 0', fontWeight: 600, color: '#1f2937' }}>Demo grant form</p>
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
