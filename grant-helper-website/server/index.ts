import path from 'path';
import { fileURLToPath } from 'url';
// import { createRequire } from 'module';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// const require = createRequire(import.meta.url);
// Load .env from project root (cwd when run via "npm run dev:server"), then try next to server/
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
if (!process.env.GEMINI_API_KEY) {
  dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
}

import express, { Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import mammoth from 'mammoth';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
let supabaseAdmin: SupabaseClient | null = null;
if (SUPABASE_URL && SUPABASE_ANON_KEY) {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error(
    'Missing GEMINI_API_KEY. Add GEMINI_API_KEY=your_key to a .env file in the project root (grant-helper-website/.env).'
  );
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const RAG_SYSTEM_INSTRUCTION = `You are a helpful grant application assistant. Answer questions using (1) the applicant's organization profile as base context, and (2) the grant opportunity details for grant-specific answers. If something cannot be found in the context, say so. Keep answers concise and practical. Do not make up deadlines, amounts, or eligibility.

`;

interface ChatMessage {
  role: 'user' | 'model';
  content: string;
}

interface ChatRequestBody {
  grantContext?: unknown;
  profileContext?: unknown;
  messages?: unknown;
}

function buildSystemInstruction(profileContext: string, grantContext: string): string {
  let out = RAG_SYSTEM_INSTRUCTION;
  if (profileContext.trim()) {
    out += `Applicant / organization profile (base context):\n${profileContext.trim()}\n\n`;
  }
  out += `Grant opportunity (use for deadlines, eligibility, amounts, etc.):\n${grantContext}`;
  return out;
}

/** Fetch combined text from document_chunks for a user (Supabase). Returns empty string if not configured or no data. */
async function fetchUserDocumentContext(userId: string): Promise<string> {
  if (!supabaseAdmin || !userId?.trim()) return '';
  const { data, error } = await supabaseAdmin
    .from('document_chunks')
    .select('content, document_id, chunk_index')
    .eq('user_id', userId)
    .order('document_id', { ascending: true })
    .order('chunk_index', { ascending: true });
  if (error) {
    console.warn('Supabase document_chunks fetch failed:', error.message);
    return '';
  }
  if (!data?.length) return '';
  return data.map((r) => r.content).filter(Boolean).join('\n\n');
}

/** Generate one grant-application answer using Gemini from context and question. */
async function generateAnswerForQuestion(context: string, question: string, wordLimit?: number): Promise<string> {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash',
    systemInstruction: `You are a grant writer. Answer the grant application question using ONLY the provided organization documents and profile. Be specific and cite details from the documents. Do not invent information. If the documents do not contain enough information, say so briefly and suggest what the applicant could add.${wordLimit ? ` Keep your answer within ${wordLimit} words.` : ''}`,
  });
  const prompt = `Context from the organization's documents and profile:\n\n${context}\n\nQuestion to answer:\n${question}\n\nProvide a direct, concise answer suitable for pasting into a grant form.`;
  const result = await model.generateContent(prompt);
  const text = result.response.text();
  return (text ?? '').trim();
}

/** Extract text from PDF using pdfjs-dist directly (avoids Buffer vs Uint8Array issues in pdf-parse). */
async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const data = Uint8Array.from(buffer);
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const loadingTask = pdfjs.getDocument({ data });
  const doc = await loadingTask.promise;
  const numPages = doc.numPages;
  const parts: string[] = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => ('str' in item ? String(item.str ?? '') : ''))
      .join(' ');
    parts.push(pageText);
    page.cleanup();
  }
  await doc.destroy();
  return parts.join('\n\n');
}

async function extractTextFromFile(buffer: Buffer, mimeType: string, filename: string): Promise<string> {

  if (mimeType === 'text/plain') {
    return buffer.toString('utf-8');
  }
  if (mimeType === 'application/pdf') {
    return await extractTextFromPdf(buffer);
  }
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword'
  ) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || '';
  }
  return `[Unsupported type ${mimeType} for ${filename}]`;
}

/** POST /api/extract-documents
 * Multipart form with "files" (array of files). Returns { text: string }.
 */
app.post('/api/extract-documents', upload.array('files', 20), async (req: Request, res: Response): Promise<void> => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files?.length) {
      res.status(400).json({ error: 'No files uploaded. Send multipart form with field "files".' });
      return;
    }
    const parts: string[] = [];
    for (const file of files) {
      const text = await extractTextFromFile(file.buffer, file.mimetype, file.originalname);
      const trimmed = text.trim();
      if (trimmed) {
        parts.push(`--- ${file.originalname} ---\n${trimmed}`);
      }
    }
    res.json({ text: parts.join('\n\n') });
  } catch (err) {
    console.error('Extract error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to extract text from documents',
    });
  }
});

/** POST /api/chat
 * Body: { grantContext: string, profileContext?: string, messages: ChatMessage[] }
 * Returns: { reply: string }
 */
app.post('/api/chat', async (req: Request, res: Response): Promise<void> => {
  try {
    const { grantContext, profileContext, messages } = req.body as ChatRequestBody;
    if (!grantContext || typeof grantContext !== 'string') {
      res.status(400).json({ error: 'grantContext is required and must be a string' });
      return;
    }
    if (!Array.isArray(messages)) {
      res.status(400).json({ error: 'messages must be an array' });
      return;
    }
    const profile = typeof profileContext === 'string' ? profileContext : '';

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: buildSystemInstruction(profile, grantContext),
    });

    const valid = (messages as ChatMessage[]).filter((m) => m.role && m.content);
    const history = valid.slice(0, -1).map((m) => ({
      role: (m.role === 'model' ? 'model' : 'user') as 'user' | 'model',
      parts: [{ text: m.content }],
    }));
    const lastMessage = valid[valid.length - 1];
    const toSend =
      lastMessage?.role === 'user'
        ? lastMessage.content
        : 'Say you are ready to answer questions about this grant.';

    const chat = model.startChat({ history });
    const result = await chat.sendMessage(toSend);
    const response = result.response;
    const text = response.text();

    res.json({ reply: text ?? '' });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const message =
      status === 429
        ? "Rate limit exceeded. Please wait a minute and try again, or check your Gemini API quota."
        : err instanceof Error
          ? err.message
          : 'Failed to get reply from assistant';
    console.error('Chat error:', err);
    res.status(status === 429 ? 429 : 500).json({ error: message });
  }
});

/** POST /api/google-form/prefill
 * Body: { formId, organizationProfile?, entryIds, questions?, userId? }
 * - entryIds: maps field names to Google Form entry IDs (e.g. "impact" -> "entry.216607139" or "216607139").
 * - questions: optional Record<fieldName, questionText>. If provided, answers are generated with Gemini using
 *   context = organizationProfile + (if userId) document_chunks from Supabase; then URLSearchParams are filled.
 * - userId: optional; when set and Supabase is configured, document_chunks for this user are used as context.
 * Returns: { url: string, answers?: Record<string, string> } — pre-fill URL and optionally the generated answers.
 */
interface GoogleFormPrefillBody {
  formId?: string;
  organizationProfile?: string;
  entryIds?: Record<string, string>;
  questions?: Record<string, string>;
  userId?: string;
}

function normalizeEntryKey(entryId: string): string {
  const t = entryId.trim();
  return t.startsWith('entry.') ? t : `entry.${t}`;
}

app.post('/api/google-form/prefill', async (req: Request, res: Response): Promise<void> => {
  try {
    const { formId, organizationProfile = '', entryIds = {}, questions = {}, userId } = req.body as GoogleFormPrefillBody;
    if (!formId || typeof formId !== 'string') {
      res.status(400).json({ error: 'formId is required and must be a string' });
      return;
    }

    let context = organizationProfile.trim();
    if (userId?.trim() && supabaseAdmin) {
      const docContext = await fetchUserDocumentContext(userId);
      if (docContext) context = (context ? context + '\n\n--- Documents from Supabase ---\n\n' : '') + docContext;
    }
    if (!context && Object.keys(questions).length > 0) {
      res.status(400).json({ error: 'Provide organizationProfile or a userId with documents in Supabase to generate answers.' });
      return;
    }

    const answers: Record<string, string> = {};
    if (Object.keys(questions).length > 0 && context) {
      for (const [field, questionText] of Object.entries(questions)) {
        if (!questionText?.trim()) continue;
        const wordMatch = questionText.match(/Max\s+(\d+)\s+words/i);
        const wordLimit = wordMatch ? parseInt(wordMatch[1], 10) : undefined;
        const answer = await generateAnswerForQuestion(context, questionText, wordLimit);
        answers[field] = answer;
      }
    }

    const base = `https://docs.google.com/forms/d/e/${formId.trim()}/viewform`;
    const params = new URLSearchParams();
    params.set('usp', 'pp_url');

    for (const [field, entryId] of Object.entries(entryIds)) {
      if (!entryId?.trim()) continue;
      const key = normalizeEntryKey(entryId);
      const value = answers[field] ?? (typeof (req.body as Record<string, unknown>)[field] === 'string' ? (req.body as Record<string, unknown>)[field] as string : field === 'profile' ? organizationProfile : '');
      if (value) params.set(key, value);
    }

    const url = `${base}?${params.toString()}`;
    res.json({ url, ...(Object.keys(answers).length > 0 ? { answers } : {}) });
  } catch (err) {
    console.error('Google Form prefill error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to build prefill URL',
    });
  }
});

/** GET /api/google-form/prefill-url
 * Query: formId, entryIds as JSON string or entry.XXX=value.
 * Redirects to the Google Form pre-fill URL (uses GET as requested).
 */
app.get('/api/google-form/prefill-url', (req: Request, res: Response): void => {
  const formId = typeof req.query.formId === 'string' ? req.query.formId.trim() : '';
  const organizationProfile = typeof req.query.profile === 'string' ? req.query.profile : '';
  if (!formId) {
    res.status(400).send('formId query parameter is required');
    return;
  }
  const base = `https://docs.google.com/forms/d/e/${formId}/viewform`;
  const params = new URLSearchParams();
  params.set('usp', 'pp_url');
  const entryIdsJson = req.query.entryIds;
  if (typeof entryIdsJson === 'string') {
    try {
      const entryIds = JSON.parse(entryIdsJson) as Record<string, string>;
      if (entryIds.profile && organizationProfile) {
        params.set(`entry.${entryIds.profile}`, organizationProfile);
      }
      for (const [key, entryId] of Object.entries(entryIds)) {
        if (key !== 'profile' && entryId && req.query[key] !== undefined) {
          params.set(`entry.${entryId}`, String(req.query[key]));
        }
      }
    } catch {
      // ignore invalid JSON
    }
  }
  const url = `${base}?${params.toString()}`;
  res.redirect(302, url);
});

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  console.log(`Grant chat API listening on http://localhost:${PORT}`);
});