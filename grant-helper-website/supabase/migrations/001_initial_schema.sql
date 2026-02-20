-- GrantFlow Supabase Schema
-- This migration sets up the production-ready architecture for user document storage and RAG

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Enable pgvector for embeddings (optional, for future vector search)
-- CREATE EXTENSION IF NOT EXISTS vector;

-- Documents table: metadata for uploaded files
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    storage_path TEXT NOT NULL, -- Format: {user_id}/{document_id}/{filename}
    file_size_bytes BIGINT,
    status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'processing', 'ready', 'failed')),
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- Document chunks table: extracted text chunks for RAG
CREATE TABLE document_chunks (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER NOT NULL,
    content TEXT NOT NULL,
    page_number INTEGER, -- For PDFs
    source_info JSONB, -- Additional metadata (section, page range, etc.)
    -- Uncomment for vector search:
    -- embedding vector(1536), -- OpenAI ada-002 dimensions
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_documents_user_id ON documents(user_id);
CREATE INDEX idx_documents_status ON documents(status);
CREATE INDEX idx_document_chunks_user_id ON document_chunks(user_id);
CREATE INDEX idx_document_chunks_document_id ON document_chunks(document_id);
CREATE INDEX idx_document_chunks_content_search ON document_chunks USING gin(to_tsvector('english', content));
-- Uncomment for vector search:
-- CREATE INDEX idx_document_chunks_embedding ON document_chunks USING ivfflat (embedding vector_cosine_ops);

-- Row Level Security (RLS) Policies

-- Enable RLS
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_chunks ENABLE ROW LEVEL SECURITY;

-- Documents policies: users can only access their own documents
CREATE POLICY "Users can view own documents"
    ON documents FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own documents"
    ON documents FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own documents"
    ON documents FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own documents"
    ON documents FOR DELETE
    USING (auth.uid() = user_id);

-- Document chunks policies: users can only access chunks from their documents
CREATE POLICY "Users can view own document chunks"
    ON document_chunks FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own document chunks"
    ON document_chunks FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own document chunks"
    ON document_chunks FOR DELETE
    USING (auth.uid() = user_id);

-- Storage policies (to be configured in Supabase Storage UI):
--
-- Bucket: user-docs (private)
--
-- Upload policy:
--   Allow INSERT if bucket_id = 'user-docs' AND
--   (storage.foldername(name))[1] = auth.uid()::text
--
-- Select policy (for downloads):
--   Allow SELECT if bucket_id = 'user-docs' AND
--   (storage.foldername(name))[1] = auth.uid()::text
--
-- Delete policy:
--   Allow DELETE if bucket_id = 'user-docs' AND
--   (storage.foldername(name))[1] = auth.uid()::text

-- Functions for full-text search (keyword-based RAG for MVP)
CREATE OR REPLACE FUNCTION search_user_documents(
    p_user_id UUID,
    p_query TEXT,
    p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
    chunk_id UUID,
    document_id UUID,
    filename TEXT,
    content TEXT,
    chunk_index INTEGER,
    page_number INTEGER,
    relevance REAL
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        dc.id AS chunk_id,
        dc.document_id,
        d.filename,
        dc.content,
        dc.chunk_index,
        dc.page_number,
        ts_rank(to_tsvector('english', dc.content), plainto_tsquery('english', p_query)) AS relevance
    FROM document_chunks dc
    JOIN documents d ON dc.document_id = d.id
    WHERE
        dc.user_id = p_user_id
        AND d.status = 'ready'
        AND to_tsvector('english', dc.content) @@ plainto_tsquery('english', p_query)
    ORDER BY relevance DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION search_user_documents TO authenticated;

-- Trigger to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_documents_updated_at
    BEFORE UPDATE ON documents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();
