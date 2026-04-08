import { useState, useRef, useCallback, useEffect } from 'react';
import { extractDocuments } from '../../api/extractDocuments';
import { supabase, isSupabaseConfigured, uploadToSupabase, getUserDocuments, deleteDocument } from '../../config/supabase';
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
  { icon: 'A', label: 'IRS Determination Letter (501(c)(3))' },
  { icon: 'B', label: 'Articles of Incorporation' },
  { icon: 'C', label: 'IRS Form 990' },
  { icon: 'D', label: 'Bylaws' },
  { icon: 'E', label: 'Annual Report' },
  { icon: 'F', label: 'Strategic Plan' },
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
            <div className="profile-landing-panel">
              <p className="profile-hero-kicker">Organization profile</p>
              <h2 className="empty-state-title">Build your grant-ready organization profile</h2>
              <p className="empty-state-description">
                Upload the files your team already maintains so GrantFlow can organize the details that
                repeat across grant search, drafting, and applications.
              </p>
              <div className="empty-state-actions">
                <button className="btn-primary" onClick={() => setShowUpload(true)}>
                  Upload documents
                </button>
                <button className="btn-secondary">Import from EIN</button>
              </div>
              <p className="profile-landing-note">
                Start with incorporation documents, tax filings, annual reports, and any materials that
                describe your mission and programs.
              </p>
            </div>
          </div>

          <div className="profile-landing-side">
            {savedDocumentsSection}
          </div>
        </div>

        <div className="feature-grid feature-grid--profile">
          <div className="feature-card">
            <div className="feature-index">01</div>
            <h3 className="feature-title">Shared profile context</h3>
            <p className="feature-text">
              Keep mission, history, programs, and core organizational details in one reusable place.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-index">02</div>
            <h3 className="feature-title">Faster grant search</h3>
            <p className="feature-text">
              Use uploaded materials to narrow the search toward grants that better fit the organization.
            </p>
          </div>
          <div className="feature-card">
            <div className="feature-index">03</div>
            <h3 className="feature-title">Less repeated entry</h3>
            <p className="feature-text">
              Reuse factual information across applications instead of rebuilding the same answers each time.
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
              {extracting ? 'Processing…' : 'Build profile'}
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
