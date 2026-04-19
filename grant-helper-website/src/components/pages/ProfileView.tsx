import { useState, useRef, useCallback, useEffect } from 'react';
import { extractDocuments } from '../../api/extractDocuments';
import { lookupEIN } from '../../api/einLookup';
import { deleteDocument, supabase, uploadToSupabase, saveOrganizationProfileText, fetchOrganizationProfile, getUserDocuments, isSupabaseConfigured } from '../../config/supabase';
import './EmptyState.css';
import './ProfileView.css';

const PROFILE_STORAGE_KEY = 'grantflow.organizationProfile';
const SAVED_DOCUMENTS_STORAGE_KEY = 'grantflow.savedDocuments';

function extractOrganizationName(profile: string) {
  const trimmed = profile.trim();
  if (!trimmed) return '';

  const labeledMatch = trimmed.match(/(?:organization name|nonprofit name|org name)\s*[:\-]\s*([^\n.]+)/i);
  if (labeledMatch?.[1]) {
    return labeledMatch[1].trim();
  }

  const firstLine = trimmed.split('\n').map((line) => line.trim()).find(Boolean) || '';
  if (firstLine && firstLine.length <= 90) {
    return firstLine.replace(/^[0-9.\-\s]+/, '').trim();
  }

  return '';
}

/** Write profile text + document names to localStorage so the Chrome extension and other views can read them. */
function syncToLocalStorage(profileText: string, docNames: string[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(PROFILE_STORAGE_KEY, profileText);
  window.localStorage.setItem(SAVED_DOCUMENTS_STORAGE_KEY, JSON.stringify(docNames));
}

type UploadedFile = {
  id: string;
  file: File;
  status: 'ready';
};

const ACCEPTED_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
];

const ACCEPTED_EXTENSIONS = '.pdf, .doc, .docx, .txt';

const FILE_TYPE_LABELS: Record<string, string> = {
  'application/pdf': 'PDF',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'text/plain': 'TXT',
};

const SUGGESTED_DOCS = [
  { icon: 'A', label: 'IRS Determination Letter (501(c)(3))' },
  { icon: 'B', label: 'Articles of Incorporation' },
  { icon: 'C', label: 'IRS Form 990' },
  { icon: 'D', label: 'Bylaws' },
  { icon: 'E', label: 'Annual Report' },
  { icon: 'F', label: 'Strategic Plan' },
];

const PROFILE_MODULES = [
  {
    id: 'identity',
    label: 'Organization identity',
    title: 'Pull core facts from the documents you already keep on hand.',
    copy: 'Capture mission, incorporation details, tax status, geographic service area, and contact information so every new application starts from a stronger baseline.',
    bullets: ['Mission and program language', 'Registered name and nonprofit status', 'Contact and mailing details'],
  },
  {
    id: 'discovery',
    label: 'Grant discovery',
    title: 'Turn one profile into a more personalized grant shortlist.',
    copy: 'Use stored organization context to narrow toward opportunities that better match your mission, program model, and nonprofit footprint.',
    bullets: ['Profile-aware search filters', 'Faster qualification screening', 'Less time wasted on poor-fit grants'],
  },
  {
    id: 'applications',
    label: 'Application support',
    title: 'Reuse the same trusted details across repeated forms.',
    copy: 'Keep organizational facts, operating language, and recurring answers ready for drafting and autofill so the team spends less time rewriting the same content.',
    bullets: ['Shared answers across applications', 'Document-grounded drafting context', 'Cleaner handoff into autofill'],
  },
];

const PROFILE_FAQS = [
  {
    id: 'docs',
    question: 'What should we upload first?',
    answer: 'Start with the documents your team already uses to explain the organization: tax filings, incorporation paperwork, annual reports, strategic plans, and any program materials that show mission and impact.',
  },
  {
    id: 'search',
    question: 'How does this help with grant search?',
    answer: 'GrantFlow uses the organization profile as reusable context so search is based on who the nonprofit is and what it actually does, instead of starting from a blank search box every time.',
  },
  {
    id: 'team',
    question: 'Why is this helpful for smaller teams?',
    answer: 'Small teams usually do the same intake, copy-paste, and fact-checking work again and again. Centralizing those details reduces repeated labor and makes it easier to move faster with fewer people.',
  },
];

const HERO_STATS = [
  { value: 'Hours back', label: 'Cut repeated search, data gathering, and application prep from every cycle.' },
  { value: '1 profile', label: 'Keep one reusable source of truth for mission, programs, compliance, and contact details.' },
  { value: 'Better fit', label: 'Use organization context to spend more time on grants that actually match your work.' },
];

const TRUST_TAGS = [
  'Organization profile',
  'Grant-fit search',
  'Document-grounded drafting',
  'Application autofill',
  'Shared team context',
];

const SUCCESS_STORIES = [
  {
    quote: 'We stopped rebuilding our nonprofit story from scratch every time a new grant opened.',
    role: 'Development lead',
    result: 'Reused one profile across search, drafting, and autofill.',
  },
  {
    quote: 'The biggest improvement was spending less time on grants that were never a good fit.',
    role: 'Operations manager',
    result: 'Used the profile to narrow toward better opportunities earlier.',
  },
  {
    quote: 'This feels more like a workflow system than just another AI text box.',
    role: 'Grant consultant',
    result: 'Turned scattered documents into one clean application layer.',
  },
];

interface ProfileViewProps {
  organizationProfile: string;
  onOrganizationProfileChange?: (value: string) => void;
}

type SavedDocument = {
  id: string;
  filename: string;
  mime_type?: string | null;
  file_size_bytes?: number | null;
  created_at?: string | null;
  status?: string | null;
};

export default function ProfileView({ organizationProfile, onOrganizationProfileChange,
}: ProfileViewProps) {
  const [showUpload, setShowUpload] = useState(false);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [uploadWarning, setUploadWarning] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [savedDocuments, setSavedDocuments] = useState<SavedDocument[]>([]);
  const [savedDocsLoading, setSavedDocsLoading] = useState(false);
  const [savedDocsError, setSavedDocsError] = useState<string | null>(null);
  const [deletingDocumentId, setDeletingDocumentId] = useState<string | null>(null);
  const [activeModule, setActiveModule] = useState(PROFILE_MODULES[0].id);
  const [openFaq, setOpenFaq] = useState<string | null>(PROFILE_FAQS[0].id);
  const [connectedUserId, setConnectedUserId] = useState(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem('grantflow.userId') || '';
  });
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Sync saved document names to localStorage whenever they change
  useEffect(() => {
    const names = savedDocuments.map((d) => d.filename).filter(Boolean);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SAVED_DOCUMENTS_STORAGE_KEY, JSON.stringify(names));
    }
  }, [savedDocuments]);

  // Hydrate localStorage from Supabase on mount (for returning users)
  useEffect(() => {
    if (typeof window === 'undefined' || !supabase) return;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const userId = session?.user?.id;
        if (!userId) return;
        window.localStorage.setItem('grantflow.userId', userId);

        // Load profile from Supabase if localStorage is empty
        if (!window.localStorage.getItem(PROFILE_STORAGE_KEY)) {
          const profile = await fetchOrganizationProfile(userId);
          if (profile?.organization_profile) {
            window.localStorage.setItem(PROFILE_STORAGE_KEY, profile.organization_profile);
          }
        }
      } catch (e) {
        console.warn('Could not hydrate localStorage from Supabase:', e);
      }
    })();
  }, []);

  const [showEINModal, setShowEINModal] = useState(false);
  const [einValue, setEINValue] = useState('');
  const [einLoading, setEINLoading] = useState(false);
  const [einError, setEINError] = useState<string | null>(null);


  const addFiles = useCallback((incoming: FileList | File[]) => {
    const valid = Array.from(incoming).filter((f) =>
      ACCEPTED_TYPES.includes(f.type)
    );
    const newEntries: UploadedFile[] = valid.map((f) => ({
      id: `${f.name}-${f.lastModified}`,
      file: f,
      status: 'ready',
    }));
    setFiles((prev) => {
      const existingIds = new Set(prev.map((e) => e.id));
      return [...prev, ...newEntries.filter((e) => !existingIds.has(e.id))];
    });
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      addFiles(e.dataTransfer.files);
    },
    [addFiles]
  );

  const handleRemove = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatSavedDate = (value?: string | null) => {
    if (!value) return 'Recently added';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const loadSavedDocuments = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setSavedDocuments([]);
      setSavedDocsError(null);
      return;
    }

    setSavedDocsLoading(true);
    setSavedDocsError(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) {
        setSavedDocuments([]);
        return;
      }

      if (typeof window !== 'undefined') {
        window.localStorage.setItem('grantflow.userId', userId);
      }

      const docs = await getUserDocuments(userId);
      setSavedDocuments((docs || []) as SavedDocument[]);
    } catch (error) {
      console.warn('Could not load saved documents', error);
      setSavedDocsError('Could not load saved documents right now.');
    } finally {
      setSavedDocsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSavedDocuments();
  }, [loadSavedDocuments]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(
      SAVED_DOCUMENTS_STORAGE_KEY,
      JSON.stringify(savedDocuments.map((doc) => doc.filename).filter(Boolean))
    );
  }, [savedDocuments]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const syncUser = () => {
      setConnectedUserId(window.localStorage.getItem('grantflow.userId') || '');
    };

    syncUser();
    window.addEventListener('storage', syncUser);
    window.addEventListener('focus', syncUser);
    return () => {
      window.removeEventListener('storage', syncUser);
      window.removeEventListener('focus', syncUser);
    };
  }, []);

  const handleDeleteSavedDocument = useCallback(async (documentId: string, filename: string) => {
    const confirmed = window.confirm(`Remove "${filename}" from this account?`);
    if (!confirmed) {
      return;
    }

    setDeletingDocumentId(documentId);
    setSavedDocsError(null);
    setSaveSuccess(null);
    try {
      await deleteDocument(documentId);
      setSavedDocuments((prev) => prev.filter((doc) => doc.id !== documentId));
      setSaveSuccess(`Removed ${filename} from this account.`);
    } catch (error) {
      console.warn('Could not delete saved document', error);
      setSavedDocsError(
        error instanceof Error ? error.message : 'Could not remove this document right now.'
      );
    } finally {
      setDeletingDocumentId(null);
    }
  }, []);

  const savedDocumentsSection = (
    <div className="saved-documents-card">
      <div className="saved-documents-header">
        <div>
          <h3 className="saved-documents-title">Saved documents</h3>
          <p className="saved-documents-subtitle">
            Files already stored for this organization account.
          </p>
        </div>
        <button
          type="button"
          className="saved-documents-refresh"
          onClick={() => loadSavedDocuments()}
          disabled={savedDocsLoading}
        >
          {savedDocsLoading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {savedDocsError && (
        <p className="saved-documents-error" role="alert">
          {savedDocsError}
        </p>
      )}

      {!savedDocsError && savedDocsLoading && (
        <p className="saved-documents-empty">Loading saved documents...</p>
      )}

      {!savedDocsLoading && !savedDocsError && savedDocuments.length === 0 && (
        <p className="saved-documents-empty">
          No saved documents yet. Upload a few files to build the organization profile.
        </p>
      )}

      {savedDocuments.length > 0 && (
        <ul className="saved-documents-list">
          {savedDocuments.map((doc) => (
            <li key={doc.id} className="saved-document-item">
              <div className="saved-document-main">
                <span className="saved-document-name">{doc.filename}</span>
                <span className="saved-document-meta">
                  {[formatSavedDate(doc.created_at), doc.file_size_bytes ? formatSize(doc.file_size_bytes) : '']
                    .filter(Boolean)
                    .join(' • ')}
                </span>
              </div>
              <div className="saved-document-actions">
                <span className="saved-document-status">
                  {(doc.status || 'saved').replace(/_/g, ' ')}
                </span>
                <button
                  type="button"
                  className="saved-document-delete"
                  onClick={() => handleDeleteSavedDocument(doc.id, doc.filename)}
                  disabled={deletingDocumentId === doc.id}
                >
                  {deletingDocumentId === doc.id ? 'Removing...' : 'Remove'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  const selectedModule =
    PROFILE_MODULES.find((module) => module.id === activeModule) ?? PROFILE_MODULES[0];
  const isConnected = Boolean(connectedUserId);
  const organizationName = extractOrganizationName(organizationProfile) || 'your organization';

  if (!showUpload) {
    return (
      <div className="empty-state">
        {saveSuccess && (
          <div className="upload-success" role="status">
            {saveSuccess}
          </div>
        )}

        {showEINModal && (
          <div className="ein-modal-overlay" onClick={() => setShowEINModal(false)}>
            <div className="ein-modal" onClick={(e) => e.stopPropagation()}>
              <h3 className="ein-modal-title">Import from EIN</h3>
              <p className="ein-modal-subtitle">
                Enter your organization's Employer Identification Number (EIN) to automatically import your public IRS 990 filings and organization profile.
              </p>
              <input
                className="ein-input"
                type="text"
                placeholder="XX-XXXXXXX"
                value={einValue}
                maxLength={10}
                onChange={(e) => {
                  const raw = e.target.value.replace(/\D/g, '');
                  setEINValue(raw.length > 2 ? `${raw.slice(0, 2)}-${raw.slice(2)}` : raw);
                  setEINError(null);
                }}
              />
              {einError && <p className="ein-error">{einError}</p>}
              <div className="ein-modal-actions">
                <button className="btn-secondary" onClick={() => setShowEINModal(false)} disabled={einLoading}>
                  Cancel
                </button>
                <button
                  className="btn-primary"
                  disabled={einLoading || einValue.replace(/\D/g, '').length !== 9}
                  onClick={async () => {
                    if (!supabase) return;
                    setEINLoading(true);
                    setEINError(null);
                    try {
                      const { data: { session } } = await supabase.auth.getSession();
                      if (!session?.user) {
                        setEINError('Please sign in before importing via EIN so your data can be saved.');
                        return;
                      }
                      const { orgName, text } = await lookupEIN(einValue);

                      syncToLocalStorage(text, [...savedDocuments.map(d => d.filename), `EIN-${einValue.replace(/\D/g, '')}.txt`].filter(Boolean));

                      const cleanEIN = einValue.replace(/\D/g, '');
                      const filename = `EIN-${cleanEIN}${orgName ? `-${orgName}` : ''}.txt`;
                      const einBlob = new File([text], filename, { type: 'text/plain' });
                      try {
                        await uploadToSupabase(einBlob, session.user.id);
                        await loadSavedDocuments();
                      } catch (uploadErr) {
                        console.warn('Failed to save EIN data to Supabase:', uploadErr);
                      }

                      try {
                        await saveOrganizationProfileText(session.user.id, text);
                      } catch (saveErr) {
                        console.warn('Failed to save profile to Supabase:', saveErr);
                      }
                      setShowEINModal(false);
                    } catch (err) {
                      setEINError(err instanceof Error ? err.message : 'Lookup failed. Check the EIN and try again.');
                    } finally {
                      setEINLoading(false);
                    }
                  }}
                >
                  {einLoading ? 'Importing…' : 'Import'}
                </button>
              </div>
            </div>
          </div>
        )}
        <div className={`profile-landing-grid ${isConnected ? '' : 'profile-landing-grid--solo'}`}>
          <div className="profile-landing-main">
            <div className="profile-landing-panel">
              <div className="profile-hero-shell">
                <p className="profile-hero-kicker">Organization profile</p>
                <h2 className="empty-state-title profile-hero-title">
                  {isConnected
                    ? `Welcome back, ${organizationName}.`
                    : 'Turn the documents your nonprofit already has into reusable grant context.'}
                </h2>
                <p className="empty-state-description profile-hero-description">
                  {isConnected
                    ? 'Here is the shared organization context your team can keep current and reuse across applications.'
                    : 'Build one organization profile for better-fit discovery, faster drafting, and less repeated application work across every new opportunity.'}
                </p>
              </div>
              <div className="empty-state-actions">
                <button className="btn-primary btn-primary--hero" onClick={() => setShowUpload(true)}>
                  <span>{isConnected ? 'Add more documents' : 'Upload documents'}</span>
                  <span className="btn-arrow" aria-hidden="true">↗</span>
                </button>
                <button className="btn-secondary btn-secondary--hero">
                  <span>Import from EIN</span>
                  <span className="btn-arrow" aria-hidden="true">→</span>
                </button>
              </div>
              <p className="profile-landing-note">
                Start with incorporation documents, tax filings, annual reports, and any materials that
                describe your mission and programs.
              </p>
              <div className="profile-hero-inline-note">
                <span className="profile-hero-inline-badge">{isConnected ? 'Account ready' : 'Built for lean teams'}</span>
                <p className="profile-hero-inline-copy">
                  {isConnected
                    ? 'Upload new materials as they come in and keep the profile current for the next application.'
                    : 'Centralize the details that repeat across every grant so search and application work starts from context, not from zero.'}
                </p>
              </div>
              {!isConnected && (
                <>
                  <div className="profile-stats-strip">
                    {HERO_STATS.map((stat) => (
                      <article key={stat.value} className="profile-stat-pill">
                        <span className="profile-stat-pill-value">{stat.value}</span>
                        <span className="profile-stat-pill-label">{stat.label}</span>
                      </article>
                    ))}
                  </div>
                  <div className="profile-trust-row" aria-label="GrantFlow capabilities">
                    {TRUST_TAGS.map((tag) => (
                      <span key={tag} className="profile-trust-pill">{tag}</span>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {isConnected && (
            <div className="profile-landing-side">
              {savedDocumentsSection}
            </div>
          )}
        </div>

        {!isConnected && (
          <section className="profile-proof">
            <div className="profile-proof-lead">
              <p className="profile-proof-kicker">Why teams keep using GrantFlow</p>
              <h3 className="profile-proof-title">One profile becomes the engine for search, drafting, and form completion.</h3>
              <p className="profile-proof-text">
                Instead of re-explaining the same nonprofit every time, your team can keep one living profile
                and use it across the most repetitive parts of grant work.
              </p>
            </div>

            <div className="profile-proof-stats">
              <article className="proof-stat-card">
                <span className="proof-stat-value">3x</span>
                <span className="proof-stat-label">faster first draft setup</span>
                <p className="proof-stat-copy">Upload once, then reuse mission, program, and compliance details across every new opportunity.</p>
              </article>
              <article className="proof-stat-card">
                <span className="proof-stat-value">1</span>
                <span className="proof-stat-label">shared source of truth</span>
                <p className="proof-stat-copy">Keep factual organization data in one place instead of scattered across PDFs, folders, and past applications.</p>
              </article>
              <article className="proof-stat-card">
                <span className="proof-stat-value">0</span>
                <span className="proof-stat-label">needless re-entry cycles</span>
                <p className="proof-stat-copy">Reduce the repeated copy-paste work that slows down small teams and introduces avoidable mistakes.</p>
              </article>
            </div>

            <div className="profile-proof-grid">
              <article className="proof-story-card">
                <p className="proof-story-tag">Personalized discovery</p>
                <h4 className="proof-story-title">Find grants that fit the organization you already are.</h4>
                <p className="proof-story-text">
                  GrantFlow uses your profile to narrow toward opportunities that align with your mission, programs, and organizational details.
                </p>
              </article>
              <article className="proof-story-card">
                <p className="proof-story-tag">Reusable answers</p>
                <h4 className="proof-story-title">Turn everyday documents into application-ready context.</h4>
                <p className="proof-story-text">
                  Annual reports, IRS filings, incorporation docs, and program materials become reusable fuel for future applications.
                </p>
              </article>
              <article className="proof-story-card">
                <p className="proof-story-tag">Smaller teams, bigger output</p>
                <h4 className="proof-story-title">Built for nonprofits that do not have time to start from scratch.</h4>
                <p className="proof-story-text">
                  GrantFlow is designed to reduce the hours spent on repetitive grant work so teams can focus on strategy and storytelling.
                </p>
              </article>
            </div>

            <section className="profile-story-strip">
              <div className="profile-story-strip-header">
                <p className="profile-proof-kicker">Why it feels different</p>
                <h4 className="profile-module-title">More than uploaded PDFs inside a chatbot window.</h4>
              </div>
              <div className="profile-story-strip-grid">
                {SUCCESS_STORIES.map((story) => (
                  <article key={story.quote} className="profile-story-quote">
                    <p className="profile-story-quote-text">“{story.quote}”</p>
                    <span className="profile-story-quote-role">{story.role}</span>
                    <span className="profile-story-quote-result">{story.result}</span>
                  </article>
                ))}
              </div>
            </section>
          </section>
        )}

        <div className={`profile-interaction-grid ${isConnected ? 'profile-interaction-grid--solo' : ''}`}>
            <section className="profile-module-card">
              <div className="profile-module-header">
                <p className="profile-proof-kicker">{isConnected ? 'Inside your profile' : 'Explore the profile'}</p>
                <h4 className="profile-module-title">
                  {isConnected ? 'See what your team can keep organized in one place.' : 'See what GrantFlow organizes behind the scenes.'}
                </h4>
              </div>
              <div className="profile-module-tabs" role="tablist" aria-label="Profile capabilities">
                {PROFILE_MODULES.map((module) => (
                  <button
                    key={module.id}
                    type="button"
                    role="tab"
                    aria-selected={module.id === selectedModule.id}
                    className={`profile-module-tab ${module.id === selectedModule.id ? 'profile-module-tab--active' : ''}`}
                    onClick={() => setActiveModule(module.id)}
                  >
                    {module.label}
                  </button>
                ))}
              </div>

              <div className="profile-module-body">
                <h5 className="profile-module-body-title">{selectedModule.title}</h5>
                <p className="profile-module-copy">{selectedModule.copy}</p>
                <ul className="profile-module-list">
                  {selectedModule.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              </div>
            </section>

            {!isConnected && (
              <section className="profile-faq-card">
                <div className="profile-module-header">
                  <p className="profile-proof-kicker">Common questions</p>
                  <h4 className="profile-module-title">A quick look at how the profile becomes useful.</h4>
                </div>
                <div className="profile-faq-list">
                  {PROFILE_FAQS.map((item) => {
                    const isOpen = openFaq === item.id;
                    return (
                      <div key={item.id} className={`profile-faq-item ${isOpen ? 'profile-faq-item--open' : ''}`}>
                        <button
                          type="button"
                          className="profile-faq-trigger"
                          onClick={() => setOpenFaq(isOpen ? null : item.id)}
                          aria-expanded={isOpen}
                        >
                          <span>{item.question}</span>
                          <span className="profile-faq-plus" aria-hidden="true">{isOpen ? '−' : '+'}</span>
                        </button>
                        {isOpen && <p className="profile-faq-answer">{item.answer}</p>}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
      </div>
    );
  }

  return (
    <div className="upload-page">
      <div className="upload-header">
        <button className="back-button" onClick={() => setShowUpload(false)}>
          ← Back
        </button>
        <div>
          <p className="profile-hero-kicker">Upload documents</p>
          <h2 className="upload-title">Bring your core documents into one place</h2>
          <p className="upload-subtitle">
            GrantFlow reads the materials you already have, extracts reusable details, and prepares them for grant search and application support.
          </p>
        </div>
      </div>

      <div className="upload-layout">
        {/* Drop zone */}
        <div
          className={`dropzone ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPTED_EXTENSIONS}
            className="file-input-hidden"
            onChange={(e) => e.target.files && addFiles(e.target.files)}
          />
          <div className="dropzone-icon" aria-hidden="true">+</div>
          <p className="dropzone-primary">
            {dragging ? 'Drop files here' : 'Drag & drop your files here'}
          </p>
          <p className="dropzone-secondary">or click to browse</p>
          <div className="dropzone-types">
            <span className="type-badge">PDF</span>
            <span className="type-badge">DOC</span>
            <span className="type-badge">DOCX</span>
            <span className="type-badge">TXT</span>
          </div>
        </div>

        {/* Suggested documents + file list */}
        <div className="upload-sidebar">
          <div className="suggested-docs">
            <h3 className="suggested-title">Suggested Documents</h3>
            <ul className="suggested-list">
              {SUGGESTED_DOCS.map((doc) => (
                <li key={doc.label} className="suggested-item">
                  <span className="suggested-icon">{doc.icon}</span>
                  <span className="suggested-label">{doc.label}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Uploaded files */}
      {files.length > 0 && (
        <div className="file-list-section">
          <h3 className="file-list-title">Uploaded Files ({files.length})</h3>
          <ul className="file-list">
            {files.map(({ id, file }) => (
              <li key={id} className="file-item">
                <span className="file-type-badge">
                  {FILE_TYPE_LABELS[file.type] ?? 'FILE'}
                </span>
                <div className="file-info">
                  <span className="file-name">{file.name}</span>
                  <span className="file-size">{formatSize(file.size)}</span>
                </div>
                <span className="file-status-icon" aria-hidden="true">Ready</span>
                <button
                  className="file-remove"
                  onClick={() => handleRemove(id)}
                  title="Remove file"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>

          <div className="upload-actions">
            <button
              type="button"
              className="btn-primary upload-submit"
              disabled={extracting}
              onClick={async () => {
                setExtractError(null);
                setUploadWarning(null);
                setSaveSuccess(null);
                setExtracting(true);
                try {
                  const client = supabase;
                  const warnings: string[] = [];
                  // Ensure we have a user for Supabase (anonymous if needed) so uploads can be saved
                  let session = null;
                  if (client) {
                    const result = await client.auth.getSession();
                    session = result.data.session;
                  }
                  if (!session?.user && isSupabaseConfigured && client) {
                    const { data: anon, error: anonErr } = await client.auth.signInAnonymously();
                    if (anonErr) {
                      warnings.push(
                        `Documents were analyzed locally, but cloud saving is not fully configured yet: ${anonErr.message}.`
                      );
                      // Continue to extraction below so profile still works
                    }
                    if (anon?.session) session = anon.session;
                  }
                  const userId = session?.user?.id;
                  if (typeof window !== 'undefined') {
                    if (userId) {
                      window.localStorage.setItem('grantflow.userId', userId);
                    } else {
                      window.localStorage.removeItem('grantflow.userId');
                    }
                  }

                  // Upload each file to Supabase Storage + documents table when user is available
                  if (userId) {
                    for (const { file } of files) {
                      try {
                        await uploadToSupabase(file, userId);
                      } catch (uploadErr) {
                        console.warn('Supabase upload failed for', file.name, uploadErr);
                        warnings.push(
                          uploadErr instanceof Error
                            ? `${file.name} could not be saved to cloud storage, but the document was still analyzed.`
                            : 'One or more files could not be saved to your account, but extraction will continue.'
                        );
                      }
                    }
                  }

                  const accessToken = session?.access_token;
                  await extractDocuments(
                    files.map((f) => f.file),
                    accessToken ? { accessToken } : undefined
                  );

                  await loadSavedDocuments();
                  setSaveSuccess(`Saved your files and updated your organization profile from ${files.length} document${files.length === 1 ? '' : 's'}.`);
                  if (warnings.length) {
                    setUploadWarning(warnings[0]);
                  }
                  setFiles([]);
                  setShowUpload(false);
                } catch (err) {
                  console.warn('Document extraction failed', err);
                  setExtractError(err instanceof Error ? err.message : 'Failed to extract text from documents');
                } finally {
                  setExtracting(false);
                }
              }}
            >
              {extracting ? 'Analyzing with AI…' : '✨ Analyze with AI'}
            </button>
            {extractError && (
              <p className="upload-error" role="alert">
                {extractError}
              </p>
            )}
            {uploadWarning && !extractError && (
              <p className="upload-warning" role="status">
                {uploadWarning}
              </p>
            )}
            <p className="upload-hint">
              We'll extract text from your documents to personalize grant search and chat.
            </p>
          </div>
        </div>
      )}

      {savedDocumentsSection}
    </div>
  );
}
