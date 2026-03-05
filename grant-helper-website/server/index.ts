import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Load .env from project root (cwd when run via "npm run dev:server"), then try next to server/
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
if (!process.env.OPENAI_API_KEY) {
  dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
}

import express, { Request, Response } from 'express';
import cors from 'cors';
import multer from 'multer';
import mammoth from 'mammoth';
import OpenAI from 'openai';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// PDF parsing disabled for demo - use TXT or DOC files instead
// const pdfParse = require('pdf-parse');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
let supabaseAdmin: SupabaseClient | null = null;
if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error(
    'Missing OPENAI_API_KEY. Add OPENAI_API_KEY=your_key to a .env file in the project root (grant-helper-website/.env).'
  );
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const RAG_SYSTEM_INSTRUCTION = `You are a helpful grant application assistant. Answer questions using (1) the applicant's organization profile as base context, and (2) the grant opportunity details for grant-specific answers. If something cannot be found in the context, say so. Keep answers concise and practical. Do not make up deadlines, amounts, or eligibility.

`;

interface ChatMessage {
  role: 'user' | 'assistant' | 'model'; // 'model' for backwards compatibility
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

/** Extract structured organization profile from documents using LLM */
async function extractOrganizationProfile(documentText: string): Promise<Record<string, unknown>> {
  const systemPrompt = `You are a nonprofit grant consultant's data extraction assistant. Extract comprehensive information from organization documents to enable precise grant matching.`;
  const userPrompt = `Extract the following information from this nonprofit organization document. Return ONLY valid JSON with no additional text.

Document:
${documentText}

Extract into this JSON structure (use null for missing values, be thorough):
{
  "name": "Organization name",
  "annualBudget": 0,
  "location": {
    "city": "City name",
    "state": "Two-letter state code (e.g., PA, NY, TX)",
    "county": "County name if mentioned",
    "region": "Region (Northeast, Southeast, Midwest, Southwest, West)",
    "serviceArea": "local, regional, statewide, or national"
  },
  "focusAreas": ["primary focus area", "secondary areas"],
  "targetPopulation": "Specific demographics served (age, income level, etc.)",
  "organizationType": "501(c)(3), 501(c)(4), government, etc.",
  "staffSize": 0,
  "yearsOperating": 0,
  "programCapacity": "small/medium/large based on staff and budget"
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' }
  });

  const result = completion.choices[0]?.message?.content?.trim() ?? '{}';
  return JSON.parse(result);
}

/** Score and rank a grant's relevance to an organization */
async function scoreGrantMatch(orgProfile: Record<string, unknown>, grantData: Record<string, unknown>): Promise<{ score: number; explanation: string }> {
  const systemPrompt = `You are an expert grant consultant with 15+ years of experience matching nonprofits to funding opportunities. Score how well a grant matches an organization on a scale of 0-100 using a rigorous, multi-factor analysis.`;

  const userPrompt = `Organization Profile:
${JSON.stringify(orgProfile, null, 2)}

Grant Opportunity:
${JSON.stringify(grantData, null, 2)}

Analyze this match using the following weighted criteria:

1. ELIGIBILITY (Pass/Fail - if fail, score must be ≤25):
   - Organization type (501c3, government, etc.)
   - Geographic restrictions (state-specific vs national)
   - Organization size/budget requirements
   - Years in operation requirements

2. BUDGET ALIGNMENT (Weight: 25%):
   - Grant amount vs org's annual budget (ideal: 10-50% of budget)
   - Award floor/ceiling vs org's capacity
   - Matching requirements vs org's resources
   Score: 100 if perfect fit, 50 if workable, 0 if unrealistic

3. GEOGRAPHIC FIT (Weight: 30%):
   - HIGHEST PRIORITY: State/local grants matching org's location
   - MEDIUM: Regional grants that include org's state
   - LOWER: National grants (more competition)
   - Consider: Does grant explicitly target org's city/county/state?
   Score: 100 for local/state match, 70 for regional, 50 for national eligible, 0 if restricted elsewhere

4. MISSION ALIGNMENT (Weight: 35%):
   - Does grant's focus area directly match org's programs?
   - Are target populations aligned?
   - Do activities/outcomes match org's expertise?
   Score: 100 for perfect mission match, 70 for strong overlap, 40 for partial, 0 for no alignment

5. COMPETITION & FEASIBILITY (Weight: 10%):
   - Application complexity vs org's staff capacity
   - Likely competition level
   - Timeline to deadline
   Score: 100 for good fit, 50 for challenging, 0 if not feasible

SCORING GUIDANCE:
- 90-100: Excellent match - highly recommend applying
- 75-89: Strong match - good fit, worth pursuing
- 60-74: Moderate match - consider if capacity allows
- 40-59: Weak match - only if no better options
- 0-39: Poor match - not recommended

Return JSON with:
{
  "score": <0-100>,
  "explanation": "<2-3 sentence explanation covering eligibility, budget fit, geographic priority, and mission alignment>"
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' }
  });

  const result = completion.choices[0]?.message?.content?.trim() ?? '{"score": 0, "explanation": "Unable to score"}';
  return JSON.parse(result);
}

/** Generate one grant-application answer using OpenAI from context and question. */
async function generateAnswerForQuestion(context: string, question: string, wordLimit?: number): Promise<string> {
  const systemPrompt = `You are a grant writer. Answer the grant application question using ONLY the provided organization documents and profile. Be specific and cite details from the documents. Do not invent information. If the documents do not contain enough information, say so briefly and suggest what the applicant could add.${wordLimit ? ` Keep your answer within ${wordLimit} words.` : ''}`;
  const userPrompt = `Context from the organization's documents and profile:\n\n${context}\n\nQuestion to answer:\n${question}\n\nProvide a direct, concise answer suitable for pasting into a grant form.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
  });

  return completion.choices[0]?.message?.content?.trim() ?? '';
}

async function extractTextFromFile(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
  if (mimeType === 'text/plain') {
    return buffer.toString('utf-8');
  }
  if (mimeType === 'application/pdf') {
    // PDF parsing temporarily disabled - use TXT or DOC files for demo
    return '[PDF parsing is currently unavailable. Please use TXT or DOC/DOCX files instead.]';
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

    const systemInstruction = buildSystemInstruction(profile, grantContext);
    const valid = (messages as ChatMessage[]).filter((m) => m.role && m.content);

    // Convert messages to OpenAI format
    const openaiMessages = [
      { role: 'system' as const, content: systemInstruction },
      ...valid.map((m) => ({
        role: (m.role === 'model' ? 'assistant' : m.role) as 'user' | 'assistant',
        content: m.content
      }))
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: openaiMessages,
      temperature: 0.7,
    });

    const reply = completion.choices[0]?.message?.content ?? '';
    res.json({ reply });
  } catch (err) {
    const status = (err as { status?: number })?.status;
    const message =
      status === 429
        ? "Rate limit exceeded. Please wait a minute and try again, or check your OpenAI API quota."
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
 * - questions: optional Record<fieldName, questionText>. If provided, answers are generated with OpenAI using
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

/** POST /api/grants/smart-match
 * Body: { organizationProfile: string, grants: array, topN?: number }
 * Extracts org metadata, scores each grant, returns top matches with explanations
 */
interface SmartMatchRequestBody {
  organizationProfile?: string;
  grants?: unknown[];
  topN?: number;
}

app.post('/api/grants/smart-match', async (req: Request, res: Response): Promise<void> => {
  try {
    const { organizationProfile, grants, topN = 10 } = req.body as SmartMatchRequestBody;

    if (!organizationProfile || typeof organizationProfile !== 'string') {
      res.status(400).json({ error: 'organizationProfile is required and must be a string' });
      return;
    }
    if (!Array.isArray(grants) || grants.length === 0) {
      res.status(400).json({ error: 'grants must be a non-empty array' });
      return;
    }

    // Extract structured organization profile
    const orgProfile = await extractOrganizationProfile(organizationProfile);

    // Score each grant sequentially to avoid rate limits (3 requests/min on free tier)
    const scoredGrants: Array<Record<string, unknown> & { matchScore: number; matchExplanation: string }> = [];
    for (let i = 0; i < grants.length; i++) {
      const grant = grants[i];
      try {
        // Add delay between requests (except first) to respect rate limits
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 25000)); // 25 second delay to stay under 3 RPM
        }

        const { score, explanation } = await scoreGrantMatch(orgProfile, grant as Record<string, unknown>);
        scoredGrants.push({
          ...grant,
          matchScore: score,
          matchExplanation: explanation
        });
      } catch (err) {
        console.error(`Failed to score grant ${i}:`, err);
        // Continue with next grant even if one fails
        scoredGrants.push({
          ...grant,
          matchScore: 0,
          matchExplanation: 'Failed to score this grant due to an error.'
        });
      }
    }

    // Sort by score and return top N
    const topMatches = scoredGrants
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, topN);

    res.json({
      organizationProfile: orgProfile,
      matches: topMatches,
      totalScored: grants.length
    });
  } catch (err) {
    console.error('Smart match error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to match grants',
    });
  }
});

/** POST /api/profile/extract
 * Body: { text: string }
 * Extracts structured organization metadata from document text
 * Returns: { profile: OrganizationProfile }
 */
interface ExtractProfileBody {
  text?: string;
}

app.post('/api/profile/extract', async (req: Request, res: Response): Promise<void> => {
  try {
    const { text } = req.body as ExtractProfileBody;

    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text is required and must be a string' });
      return;
    }

    const profile = await extractOrganizationProfile(text);
    res.json({ profile });
  } catch (err) {
    console.error('Profile extraction error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to extract profile',
    });
  }
});

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  console.log(`Grant chat API listening on http://localhost:${PORT}`);
});