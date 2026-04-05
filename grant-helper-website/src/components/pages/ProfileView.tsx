import { useState, useRef, useCallback, useEffect } from 'react';
import { extractDocuments } from '../../api/extractDocuments';
import { lookupEIN } from '../../api/einLookup';
import { supabase, uploadToSupabase, getUserDocuments, deleteDocument, saveOrganizationProfileText } from '../../config/supabase';
import './EmptyState.css';
import './ProfileView.css';

const PROFILE_STORAGE_KEY = 'grantflow.organizationProfile';
const PROFILE_SUMMARY_STORAGE_KEY = 'grantflow.profileSummary';
const SAVED_DOCUMENTS_STORAGE_KEY = 'grantflow.savedDocuments';

function buildProfileSummary(profile: string) {
  const trimmed = profile.trim();
  const preview = trimmed.slice(0, 320);
  const sentenceCount = trimmed ? trimmed.split(/[.!?]+/).filter(Boolean).length : 0;

  return {
    preview,
    characters: trimmed.length,
    sentences: sentenceCount,
    updatedAt: new Date().toISOString(),
  };
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
  { icon: '📄', label: 'IRS Determination Letter (501(c)(3))' },
  { icon: '📋', label: 'Articles of Incorporation' },
  { icon: '📊', label: 'IRS Form 990' },
  { icon: '📝', label: 'Bylaws' },
  { icon: '📈', label: 'Annual Report' },
  { icon: '💼', label: 'Strategic Plan' },
];

interface ProfileViewProps {
  organizationProfile: string;
  onOrganizationProfileChange: (value: string) => void;
}

type SavedDocument = {
  id: string;
  filename: string;
  mime_type?: string | null;
  file_size_bytes?: number | null;
  created_at?: string | null;
  status?: string | null;
};

export default function ProfileView({onOrganizationProfileChange,
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
  const [showEINModal, setShowEINModal] = useState(false);
  const [einValue, setEINValue] = useState('');
  const [einLoading, setEINLoading] = useState(false);
  const [einError, setEINError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
    const supabaseConfigured = !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
    if (!supabaseConfigured) {
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

  if (!showUpload) {
    return (
      <div className="empty-state">
        {saveSuccess && (
          <div className="upload-success" role="status">
            {saveSuccess}
          </div>
        )}
        <div className="profile-landing-grid">
          <div className="profile-landing-main">
            <div className="empty-state-icon">🏢</div>
            <h2 className="empty-state-title">Create Your Organization Profile</h2>
            <p className="empty-state-description">
              Tell us about your nonprofit so we can find the perfect grants for you.
              Upload your legal documents and our AI will extract the key details to
              match you with relevant opportunities and help draft compelling grant applications.
            </p>
            <div className="empty-state-actions">
              <button className="btn-primary" onClick={() => setShowUpload(true)}>
                Upload documents
              </button>
              <button className="btn-secondary" onClick={() => { setShowEINModal(true); setEINError(null); setEINValue(''); }}>
                Import from EIN
              </button>
            </div>

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
                        setEINLoading(true);
                        setEINError(null);
                        try {
                          const { data: { session } } = await supabase.auth.getSession();
                          if (!session?.user) {
                            setEINError('Please sign in before importing via EIN so your data can be saved.');
                            return;
                          }
                          const { text } = await lookupEIN(einValue);
                          onOrganizationProfileChange(text);
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
          </div>

          <div className="profile-landing-side">
            {savedDocumentsSection}
          </div>
        </div>

        <div className="feature-grid">
          <div className="feature-card">
            <div className="feature-icon">📋</div>
            <h3 className="feature-title">Mission & Impact</h3>
            <p className="feature-text">
              Share your organization's mission, programs, and the communities you serve.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">💰</div>
            <h3 className="feature-title">Financial Details</h3>
            <p className="feature-text">
              Provide your budget, funding history, and financial needs.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-icon">🎯</div>
            <h3 className="feature-title">Focus Areas</h3>
            <p className="feature-text">
              Identify your key program areas and target populations.
            </p>
          </div>
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
          <h2 className="upload-title">Upload Your Nonprofit's Legal Documents</h2>
          <p className="upload-subtitle">
            Our AI will read your files to understand your organization and pre-fill your grant applications.
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
          <div className="dropzone-icon">📂</div>
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
                <span className="file-status-icon">✅</span>
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
                  const warnings: string[] = [];
                  // Ensure we have a user for Supabase (anonymous if needed) so uploads can be saved
                  let { data: { session } } = await supabase.auth.getSession();
                  const supabaseConfigured = !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
                  if (!session?.user && supabaseConfigured) {
                    const { data: anon, error: anonErr } = await supabase.auth.signInAnonymously();
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


                  const { text } = await extractDocuments(files.map((f) => f.file));
                  const extractedText = text.trim();
                  if (extractedText && typeof window !== 'undefined') {
                    const existingProfile = window.localStorage.getItem(PROFILE_STORAGE_KEY) || '';
                    const mergedProfile = [existingProfile.trim(), extractedText]
                      .filter(Boolean)
                      .filter((value, index, all) => all.indexOf(value) === index)
                      .join('\n\n');

                    window.localStorage.setItem(PROFILE_STORAGE_KEY, mergedProfile);
                    window.localStorage.setItem(
                      PROFILE_SUMMARY_STORAGE_KEY,
                      JSON.stringify(buildProfileSummary(mergedProfile))
                    );
                    onOrganizationProfileChange(mergedProfile);
                  } else {
                    onOrganizationProfileChange(text);
                  }

                  // Extract structured organization profile for smart matching
                  try {
                    const profileResponse = await fetch('/api/profile/extract', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ text }),
                    });

                    if (profileResponse.ok) {
                      const { profile } = await profileResponse.json();
                      console.log('Extracted organization profile:', profile);
                      // Save to localStorage for future use
                      localStorage.setItem('organizationProfile', JSON.stringify(profile));
                    }
                  } catch (profileErr) {
                    console.warn('Failed to extract structured profile:', profileErr);
                    // Continue anyway - this is optional enhancement
                  }

                  await loadSavedDocuments();
                  setSaveSuccess(`Saved your files and updated your organization profile from ${files.length} document${files.length === 1 ? '' : 's'}.`);
                  if (warnings.length) {
                    setUploadWarning(warnings[0]);
                  }
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
