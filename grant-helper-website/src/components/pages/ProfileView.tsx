import { useState, useRef, useCallback } from 'react';
import { extractDocuments } from '../../api/extractDocuments';
import { lookupEIN } from '../../api/einLookup';
import { deleteDocument, supabase, uploadToSupabase, saveOrganizationProfileText, type UserDocumentRow } from '../../config/supabase';
import './EmptyState.css';
import './ProfileView.css';

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
  onOrganizationProfileChange: (value: string) => void;
  userDocuments?: UserDocumentRow[];
}

export default function ProfileView({onOrganizationProfileChange,
  userDocuments = [],
}: ProfileViewProps) {
  const [savedDocuments, setSavedDocuments] = useState<UserDocumentRow[]>(userDocuments);
  const [showUpload, setShowUpload] = useState(false);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const handleDelete = async (id: string) => {
    const confirmed = window.confirm('Are you sure you want to delete this document?');
    if (!confirmed) return;

    setSavedDocuments(savedDocuments.filter((doc) => doc.id !== id));
    await deleteDocument(id);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatStoredDocSize = (bytes: number | null) => {
    if (bytes == null) return '';
    return formatSize(bytes);
  };

  if (!showUpload) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">🏢</div>
        <h2 className="empty-state-title">Create Your Organization Profile</h2>
        <p className="empty-state-description">
          Tell us about your nonprofit so we can find the perfect grants for you.
          Upload your legal documents and our AI will extract the key details to
          match you with relevant opportunities and help draft compelling grant applications.
        </p>
        <div className="empty-state-actions">
          <button className="btn-primary" onClick={() => setShowUpload(true)}>
            Get Started
          </button>
          <button className="btn-secondary" onClick={() => { setShowEINModal(true); setEINError(null); setEINValue(''); }}>
            Import from EIN
          </button>
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
                      await saveOrganizationProfileText(session.user.id, text);
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
      {savedDocuments.length > 0 && (
        <div className="file-list-section">
          <h3 className="file-list-title">Saved Documents ({savedDocuments.length})</h3>
          <ul className="file-list">
            {savedDocuments.map((doc) => (
              <li key={doc.id} className="file-item">
                <span className="file-type-badge">
                  {FILE_TYPE_LABELS[doc.mime_type ?? ''] ?? 'FILE'}
                </span>
                <div className="file-info">
                  <span className="file-name">{doc.filename}</span>
                  <span className="file-size">{formatStoredDocSize(doc.file_size_bytes)}</span>
                </div>
                <button
                  className="file-remove"
                  onClick={() => handleDelete(doc.id)}
                  title="Remove file">
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

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
                setExtracting(true);
                try {
                  // Ensure we have a user for Supabase (anonymous if needed) so uploads can be saved
                  const { data: { session } } = await supabase.auth.getSession();
                  const supabaseConfigured = !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
                  if (!session?.user && supabaseConfigured) {
                    // const { data: anon, error: anonErr } = await supabase.auth.signInAnonymously();
                    // if (anonErr) {
                    //   setExtractError(
                    //     `Documents could not be saved to Supabase: ${anonErr.message}. Enable Anonymous sign-in in Supabase Dashboard → Authentication → Providers.`
                    //   );
                    //   // Continue to extraction below so profile still works
                    // }
                    // if (anon?.session) session = anon.session;
                    setExtractError('Please sign in to save your documents.');
                    return;
                  }
                  const userId = session?.user?.id;

                  const uploadResults: { id: string; file: File }[] = [];
                  if (userId) {
                    for (const { file } of files) {
                      try {
                        const { id } = await uploadToSupabase(file, userId);
                        uploadResults.push({ id, file });
                      } catch (uploadErr) {
                        console.warn('Supabase upload failed for', file.name, uploadErr);
                        setExtractError(
                          uploadErr instanceof Error ? uploadErr.message : 'One or more files could not be saved to your account. Extraction will continue.'
                        );
                      }
                    }
                  }

                  const newSavedRows: UserDocumentRow[] = files.map(({ file, id: localId }) => {
                    const rowId = uploadResults.find((r) => r.file === file)?.id ?? localId;
                    return {
                      id: rowId,
                      filename: file.name,
                      mime_type: file.type,
                      file_size_bytes: file.size,
                      created_at: new Date(file.lastModified).toISOString(),
                      status: 'uploaded',
                    };
                  });

                  setSavedDocuments([...savedDocuments, ...newSavedRows]);

                  const accessToken = session?.access_token;
                  const chunksReady =
                    Boolean(accessToken) &&
                    uploadResults.length === files.length &&
                    uploadResults.length > 0;
                  const { text } = await extractDocuments(
                    files.map((f) => f.file),
                    chunksReady && accessToken
                      ? {
                          accessToken,
                          documentIds: uploadResults.map((r) => r.id),
                        }
                      : undefined
                  );
                  onOrganizationProfileChange(text);
                  setFiles([]);
                } catch (err) {
                  console.warn('Supabase upload failed for', err);
                  setExtractError(err instanceof Error ? err.message : 'Failed to extract text from documents');
                } finally {
                  setExtracting(false);
                }
              }}
            >
              {extracting ? 'Extracting…' : '✨ Analyze with AI'}
            </button>
            {extractError && (
              <p className="upload-error" role="alert">
                {extractError}
              </p>
            )}
            <p className="upload-hint">
              We'll extract text from your documents to personalize grant search and chat.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
