# GrantFlow Architecture

## Overview

GrantFlow is an AI-powered grant writing assistant that helps nonprofits discover relevant grants and receive personalized guidance based on their organizational documents.

## Current Architecture (Demo - Feb 20, 2026)

### Stack
- **Frontend**: React 19.2 + TypeScript + Vite
- **Backend**: Express.js (Node.js)
- **AI**: Google Gemini API for RAG chatbot
- **Grant Data**: Simpler.Grants.gov API
- **Storage**: Local file upload (in-memory processing)

### Data Flow

```
User uploads docs → Express server → Document extraction (PDF/DOC/TXT)
                                   ↓
                           Text chunks stored in memory
                                   ↓
User searches grants → Grants.gov API → Display results
                                       ↓
User asks about grant → Gemini API ← Grant context + User doc chunks
                                   ↓
                        AI-powered response
```

### Key Components

#### Frontend (`/src`)
- **Layout**: Sidebar navigation, TopNav, responsive layout
- **Pages**:
  - ProfileView: File upload UI (drag-drop for PDF/DOC/DOCX/TXT)
  - SearchView: Grant discovery with Grants.gov integration
  - WorkspaceView: Grant writing workspace
- **Chat**: GrantChat component for AI assistance

#### Backend (`/server`)
- **index.ts**: Express server on port 3001
- **Endpoints**:
  - `POST /api/extract-documents`: Extract text from uploaded files
  - `POST /api/chat`: Gemini-powered RAG chatbot
- **Document Processing**:
  - PDF parsing with `pdf-parse`
  - Word doc extraction with `mammoth`
  - Text chunking for context windows

#### APIs
- **Grants.gov API**: Federal grant search and discovery
- **Gemini API**: Conversational AI with RAG capabilities

## Production Architecture (Post-Hackathon)

### Why Simplified Hybrid Approach?

For the hackathon deadline (Feb 20, 12PM ET), we chose to:
1. **Keep current system working** for reliable demo
2. **Add production-ready foundation** to show scalability
3. **Document transition path** for post-hackathon implementation

### Enhanced Stack (Production)
- **Auth**: Supabase Authentication
- **Storage**: Supabase Storage (private bucket: `user-docs`)
- **Database**: PostgreSQL via Supabase
- **Document Chunking**: Persistent storage in `document_chunks` table
- **RAG**: Full-text search with `ts_rank()` (upgradeable to pgvector)

### Database Schema (`/supabase/migrations/001_initial_schema.sql`)

```sql
-- Documents: User file metadata
CREATE TABLE documents (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id),
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    storage_path TEXT NOT NULL,  -- Format: {user_id}/{doc_id}/{filename}
    status TEXT DEFAULT 'uploaded', -- uploaded | processing | ready | failed
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Document Chunks: Extracted text for RAG
CREATE TABLE document_chunks (
    id UUID PRIMARY KEY,
    user_id UUID REFERENCES auth.users(id),
    document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
    chunk_index INTEGER,
    content TEXT NOT NULL,
    page_number INTEGER,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### Row Level Security (RLS)

All tables enforce user isolation:
```sql
-- Users can only access their own documents
CREATE POLICY "Users can view own documents"
    ON documents FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can view own document chunks"
    ON document_chunks FOR SELECT
    USING (auth.uid() = user_id);
```

### RAG Implementation

#### Current (Demo)
- Files uploaded → Express extracts text → Chunks stored in memory
- Chat requests → Gemini receives chunks as context

#### Production
- Files uploaded → Supabase Storage (private bucket)
- Background worker → Extracts text → Saves to `document_chunks` table
- Chat requests → Query `search_user_documents()` function → Retrieve top-k chunks
- Gemini receives relevant chunks ranked by full-text search relevance

**Search Function**:
```sql
CREATE FUNCTION search_user_documents(
    p_user_id UUID,
    p_query TEXT,
    p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
    chunk_id UUID,
    document_id UUID,
    filename TEXT,
    content TEXT,
    relevance REAL
)
```

### Storage Architecture (Production)

```
Supabase Storage Bucket: user-docs (private)
├── {user_id_1}/
│   ├── {doc_id_a}/
│   │   └── articles-of-incorporation.pdf
│   └── {doc_id_b}/
│       └── irs-990-form.pdf
├── {user_id_2}/
│   └── {doc_id_c}/
│       └── mission-statement.docx
```

**RLS Policies**:
- Upload: User can only upload to `{their_user_id}/` folder
- Download: User can only download from `{their_user_id}/` folder
- Delete: User can only delete from `{their_user_id}/` folder

## Security

### Current
- API keys stored in `.env` (server-side only for Gemini)
- No user authentication (single-user demo)
- Files processed in memory, not persisted

### Production
- Supabase Auth for user identity
- Row Level Security (RLS) enforces multi-tenant isolation
- Storage RLS prevents unauthorized file access
- API keys managed via environment variables
- HTTPS enforced for all requests

## Scalability

### Current Limitations
- In-memory document storage (clears on server restart)
- No user accounts (single-user demo)
- Manual grant search (no personalized recommendations)

### Production Enhancements
- **Database-backed storage**: Documents persist across restarts
- **Multi-tenant**: RLS enables unlimited users with data isolation
- **Vector search** (future): Upgrade to pgvector for semantic RAG
  ```sql
  -- Add vector column to document_chunks
  ALTER TABLE document_chunks ADD COLUMN embedding vector(1536);
  CREATE INDEX ON document_chunks USING ivfflat (embedding vector_cosine_ops);
  ```
- **Background processing**: Queue system for document extraction
- **Caching**: Redis for frequently accessed chunks
- **CDN**: Static assets served via CDN for global performance

## Migration Path

### Phase 1: Foundation (Completed for Demo)
✅ SQL migration file created
✅ Supabase client config stub
✅ Architecture documentation
✅ Current system working for demo

### Phase 2: Auth & Storage (Post-Hackathon, Week 1)
- Set up Supabase project
- Run SQL migrations
- Configure Storage bucket and RLS policies
- Add Supabase Auth to frontend
- Implement login/signup flows

### Phase 3: Document Pipeline (Week 2)
- Replace in-memory upload with Supabase Storage
- Add background worker for document extraction
- Implement chunking pipeline
- Test RLS policies with multiple users

### Phase 4: RAG Enhancement (Week 3)
- Integrate `search_user_documents()` function
- Optimize full-text search parameters
- Add document status tracking (processing → ready)
- Implement error handling and retries

### Phase 5: Vector Search (Future)
- Add OpenAI embeddings generation
- Enable pgvector extension
- Create vector indexes
- Migrate from keyword to semantic search

## Technology Decisions

### Why Supabase?
- **Built on PostgreSQL**: Production-grade, familiar SQL
- **RLS**: Native multi-tenant security
- **Storage**: File hosting with RLS policies
- **Auth**: OAuth providers, email, magic links
- **Real-time**: Future potential for collaborative features

### Why Gemini?
- **Long context window**: 1M+ tokens for large documents
- **Cost-effective**: Lower pricing than GPT-4
- **Fast**: Quick response times for chat
- **Multimodal**: Future potential for image/PDF parsing

### Why Full-Text Search (not Vector)?
- **Faster to implement**: Native PostgreSQL feature
- **Sufficient for MVP**: Keyword matching works well for grants
- **Upgradeable**: Can add pgvector later without schema changes
- **Cost-effective**: No embedding API costs

## Monitoring & Observability (Production)

- **Application**: Sentry for error tracking
- **Database**: Supabase Dashboard for query performance
- **API Usage**: Track Gemini API costs and rate limits
- **User Analytics**: PostHog for feature usage

## Development Setup

### Current (Demo)
```bash
# Install dependencies
npm install

# Add API keys to .env
# Run both servers
npm run dev:all
# OR separately:
# Terminal 1: npm run dev          (Vite on 5173)
# Terminal 2: npm run dev:server   (Express on 3001)
```

### Production (Post-Hackathon)
```bash
# Add Supabase credentials to .env
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key

# Run migrations
psql -h db.your-project.supabase.co -U postgres < supabase/migrations/001_initial_schema.sql

# Create storage bucket in Supabase Dashboard
# Configure RLS policies (see migration comments)

# Deploy
npm run build
# Deploy to Vercel/Netlify/Cloudflare Pages
```

## Testing Strategy

### Demo
- Manual testing of file upload
- Grant search verification
- Chat functionality with sample documents

### Production
- Unit tests for document extraction
- Integration tests for Supabase operations
- E2E tests for auth flows
- Load testing for concurrent users
- Security testing for RLS policies

## Cost Estimates (Production)

### Monthly (1000 active users)
- **Supabase**: $25/mo (Pro plan)
- **Gemini API**: ~$50-200/mo (depends on usage)
- **Grants.gov API**: Free
- **Hosting**: $0-20/mo (Vercel/Netlify free tier)
- **Total**: ~$75-245/mo

### Scalability
- Supabase Pro supports 10GB database, 100GB bandwidth
- Upgrade to Team ($599/mo) for 50GB database if needed
- Gemini pricing scales linearly with tokens

---

**Last Updated**: February 19, 2026
**Status**: Demo-ready with production foundation
