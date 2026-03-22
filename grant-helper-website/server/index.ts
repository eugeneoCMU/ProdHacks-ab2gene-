import path from 'path';
import { fileURLToPath } from 'url';
// import { createRequire } from 'module';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// const require = createRequire(import.meta.url);
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

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error(
    'Missing OPENAI_API_KEY. Add OPENAI_API_KEY=your_key to a .env file in the project root (grant-helper-website/.env).'
  );
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const RAG_SYSTEM_INSTRUCTION = `You are the founder or program director of the organization applying for this grant.
You are personally completing this grant application. All information provided represents your organization's real operations, programs, impact, and plans.
Answer each question in a natural, professional tone as a human applicant would. Write in first person plural ("we") when referring to the organization.

Never mention context, documents, files, sources, or any external materials. Do not imply that you are referencing anything. The information is part of your own knowledge and experience as the organization.

Do not use phrases such as:
- 'based on the provided information'
- 'according to the document [file_name]'
- 'from the context'
- 'the materials state'
- ([file_name].pdf, [file_name].txt, etc.)
- or anything similar

Do not include disclaimers, uncertainty statements, or references to missing information.

If specific details are not explicitly available, provide a reasonable, truthful, and professional response consistent with the organization's mission, scale, and activities. Do not fabricate precise metrics, dates, or financial figures unless they are explicitly provided.

Use clear, natural paragraphs only. Do not use bullet points or numbered lists.
Keep the tone confident, professional, and human.
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
  const systemPrompt = `You are an expert grant consultant with 15+ years of experience matching nonprofits to funding opportunities. Score how well a grant matches an organization on a scale of 0-100 using a rigorous, multi-factor analysis.

CALIBRATION EXAMPLES - Study these to understand proper scoring:

EXAMPLE 1 - Excellent Local Match (Score: 88):
Org: Small education nonprofit, $75k budget, Pittsburgh PA, STEM programs for high schoolers, 8 years operating, 501(c)(3)
Grant: Pennsylvania Department of Education STEM Grant, $50k-150k awards, PA nonprofits only, supports after-school STEM programs
Analysis: "Organization is based in Pennsylvania and meets state eligibility requirements perfectly. Budget alignment is excellent with the grant range ($50k-150k) representing 67-200% of current budget, which is highly sustainable. Mission alignment is perfect: both focus on STEM education for high school students with after-school programming. As a state grant, competition is significantly lower than national grants and gives geographic preference. Strong match - highly recommend applying."

EXAMPLE 2 - Good National Match (Score: 72):
Org: Medium health nonprofit, $500k budget, Detroit MI, mental health services, 12 years operating, 501(c)(3)
Grant: AmeriCorps State and National, $100k-500k awards, national scope, supports health and education community service programs
Analysis: "Organization is eligible as a 501(c)(3) nonprofit with no geographic restrictions for this national grant. Budget alignment is good - grant range ($100k-500k) fits well within organizational capacity. Mission alignment is strong: AmeriCorps supports health services including mental health. However, as a national competitive grant, competition level is high with no geographic preference. Solid match worth pursuing if capacity allows for competitive application process."

EXAMPLE 3 - Weak Mission Mismatch (Score: 35):
Org: Small arts nonprofit, $150k budget, Brooklyn NY, youth theater programs, 5 years operating, 501(c)(3)
Grant: NASA STEM Workforce Development Hub, $250k-1M awards, national, focuses on aerospace technical training and workforce development
Analysis: "Organization meets basic eligibility as a 501(c)(3). However, mission alignment is very poor: grant specifically targets aerospace workforce development while organization specializes in arts and theater programming with no STEM component. Budget alignment is challenging - grant minimum ($250k) significantly exceeds org's total budget ($150k), suggesting grant is designed for substantially larger organizations. No geographic advantage. Not recommended - pursue arts education and youth development grants instead."

EXAMPLE 4 - Geographic Ineligibility (Score: 12):
Org: Rural education nonprofit, $40k budget, Lexington Kentucky, literacy programs, 4 years operating, 501(c)(3)
Grant: California State Arts Council Grant, $25k-75k awards, restricted to California-based nonprofits only
Analysis: "Organization does not meet fundamental geographic eligibility requirements - grant is explicitly restricted to California-based organizations and this organization is headquartered in Kentucky. While mission areas (education/arts/youth) have some thematic overlap and budget range would be appropriate, the geographic restriction is an absolute disqualifier. Do not apply - organization is ineligible regardless of other factors."

EXAMPLE 5 - Budget Mismatch Despite Mission Fit (Score: 42):
Org: Micro animal rescue, $30k budget, Denver CO, pet adoption programs, 3 years operating, 501(c)(3)
Grant: National Animal Welfare Foundation Major Grants, $500k-2M awards, national, supports large-scale shelter operations and regional programs
Analysis: "Organization is eligible and mission alignment is excellent - both focus on animal welfare, rescue operations, and adoption services. However, budget alignment is severely problematic: grant minimum ($500k) is over 16x the organization's annual budget, clearly indicating this grant targets major regional shelters with substantial infrastructure, not small local rescues. Managing such a large grant would overwhelm organizational capacity. Competition from large established shelters would be intense. Weak match - organization should pursue smaller regional animal welfare grants ($10k-50k range) instead."`;

  const userPrompt = `Now analyze this NEW organization and grant match using the same rigorous criteria and scoring calibration shown above:

Organization Profile:
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

/** Pass 1: Quick eligibility check to filter out obviously ineligible grants */
async function quickEligibilityCheck(orgProfile: Record<string, unknown>, grantData: Record<string, unknown>): Promise<{ eligible: boolean; reason?: string }> {
  const systemPrompt = `You are a grant eligibility screener. Quickly determine if an organization is eligible for a grant based on basic requirements.`;
  const userPrompt = `Organization Profile:
${JSON.stringify(orgProfile, null, 2)}

Grant Opportunity:
${JSON.stringify(grantData, null, 2)}

Perform a QUICK eligibility check. Check ONLY these critical factors:
1. Organization type allowed? (501c3, government, etc.)
2. Geographic restrictions met? (Is org in an allowed location?)
3. Basic budget requirements met? (Is award size remotely reasonable for org?)

Return JSON:
{
  "eligible": true/false,
  "reason": "Brief reason if ineligible (e.g., 'Geographic restriction: grant limited to California only')"
}

If any factor is clearly violated, return eligible: false. When in doubt, return eligible: true.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' }
  });

  const result = completion.choices[0]?.message?.content?.trim() ?? '{"eligible": true}';
  return JSON.parse(result);
}

/** Pass 3: Generate application tips for top matches */
async function generateApplicationTips(orgProfile: Record<string, unknown>, grantData: Record<string, unknown>, matchScore: number): Promise<string> {
  const systemPrompt = `You are an expert grant consultant helping nonprofits write winning applications. Provide specific, actionable advice for applying to this grant.`;
  const userPrompt = `Organization Profile:
${JSON.stringify(orgProfile, null, 2)}

Grant Opportunity (Match Score: ${matchScore}%):
${JSON.stringify(grantData, null, 2)}

Based on this organization's profile and the grant requirements, provide 3-4 specific application tips.

Focus on:
1. What to emphasize in their application (specific strengths that match grant priorities)
2. Suggested funding amount (realistic range based on org's budget and grant limits)
3. Key points to highlight in narrative sections
4. Any concerns to address proactively

Keep each tip to 1-2 sentences. Be specific and actionable.

Return as a plain string with tips separated by newlines (not JSON).`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.5,
  });

  return completion.choices[0]?.message?.content?.trim() ?? '';
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

    // PASS 1: Quick eligibility filter (removes ~40% of grants)
    const eligibleGrants: Array<{ grant: Record<string, unknown>; index: number }> = [];
    const ineligibleGrants: Array<Record<string, unknown> & { matchScore: number; matchExplanation: string }> = [];

    for (let i = 0; i < grants.length; i++) {
      const grant = grants[i];
      try {
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 25000)); // 25s delay for rate limits
        }

        const { eligible, reason } = await quickEligibilityCheck(orgProfile, grant as Record<string, unknown>);

        if (eligible) {
          eligibleGrants.push({ grant: grant as Record<string, unknown>, index: i });
        } else {
          // Mark ineligible grants with low score
          ineligibleGrants.push({
            ...(grant as Record<string, unknown>),
            matchScore: 10,
            matchExplanation: reason || 'Does not meet basic eligibility requirements.'
          });
        }
      } catch (err) {
        console.error(`Failed to check eligibility for grant ${i}:`, err);
        // If check fails, assume eligible to be safe
        eligibleGrants.push({ grant: grant as Record<string, unknown>, index: i });
      }
    }

    // PASS 2: Detailed scoring for eligible grants only
    const scoredGrants: Array<Record<string, unknown> & { matchScore: number; matchExplanation: string }> = [];
    for (const { grant, index } of eligibleGrants) {
      try {
        if (scoredGrants.length > 0) {
          await new Promise(resolve => setTimeout(resolve, 25000)); // 25s delay
        }

        const { score, explanation } = await scoreGrantMatch(orgProfile, grant);
        scoredGrants.push({
          ...grant,
          matchScore: score,
          matchExplanation: explanation
        });
      } catch (err) {
        console.error(`Failed to score grant ${index}:`, err);
        scoredGrants.push({
          ...grant,
          matchScore: 0,
          matchExplanation: 'Failed to score this grant due to an error.'
        });
      }
    }

    // Combine scored and ineligible grants
    const allGrants = [...scoredGrants, ...ineligibleGrants];

    // Sort by score and get top N
    const topMatches = allGrants
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, topN);

    // PASS 3: Generate application tips for top 3 matches (score >= 60)
    const matchesWithTips = await Promise.all(
      topMatches.map(async (match, index) => {
        // Only generate tips for good matches (60+) and top 3
        if (index < 3 && match.matchScore >= 60) {
          try {
            const tips = await generateApplicationTips(orgProfile, match, match.matchScore);
            return { ...match, applicationTips: tips };
          } catch (err) {
            console.error(`Failed to generate tips for grant ${index}:`, err);
            return match;
          }
        }
        return match;
      })
    );

    res.json({
      organizationProfile: orgProfile,
      matches: matchesWithTips,
      totalScored: grants.length,
      eligibleCount: eligibleGrants.length,
      ineligibleCount: ineligibleGrants.length
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

/** GET /api/grants/catalog
 * Query params: q (keyword search, optional), category (optional), limit (default 20)
 * Returns grants from local seed catalog, normalized to GrantsGovOpportunity shape
 */
import { readFileSync } from 'fs';

interface CatalogGrant {
  id: string;
  opportunity_title: string;
  provider: string;
  category: string;
  funding_min: number | null;
  funding_max: number | null;
  geographic_scope: string;
  states_eligible: string[];
  eligibility_types: string[];
  focus_areas: string[];
  target_population: string;
  description: string;
  application_url: string;
  deadline_type: string;
  typical_deadline_month: number | null;
  is_recurring: boolean;
  notes: string;
}

let _catalogGrants: CatalogGrant[] | null = null;

function loadCatalog(): CatalogGrant[] {
  if (_catalogGrants) return _catalogGrants;
  try {
    const seedPath = path.resolve(__dirname, '..', 'src', 'data', 'grants-seed.json');
    const raw = readFileSync(seedPath, 'utf8');
    const parsed = JSON.parse(raw);
    _catalogGrants = parsed.grants ?? [];
    console.log(`Loaded ${_catalogGrants!.length} grants from catalog`);
    return _catalogGrants!;
  } catch (err) {
    console.warn('Could not load grants catalog:', err instanceof Error ? err.message : err);
    return [];
  }
}

function normalizeCatalogGrant(g: CatalogGrant): Record<string, unknown> {
  return {
    opportunity_id: `catalog-${g.id}`,
    opportunity_title: g.opportunity_title,
    opportunity_number: null,
    agency_name: g.provider,
    source: 'catalog',
    category: g.category,
    geographic_scope: g.geographic_scope,
    states_eligible: g.states_eligible,
    eligibility_types: g.eligibility_types,
    focus_areas: g.focus_areas,
    target_population: g.target_population,
    application_url: g.application_url,
    is_recurring: g.is_recurring,
    deadline_type: g.deadline_type,
    typical_deadline_month: g.typical_deadline_month,
    notes: g.notes,
    summary: {
      summary_description: g.description,
      award_floor: g.funding_min,
      award_ceiling: g.funding_max,
      close_date: null,
      post_date: null,
    },
  };
}

app.get('/api/grants/catalog', (req: Request, res: Response): void => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.toLowerCase().trim() : '';
    const category = typeof req.query.category === 'string' ? req.query.category.toLowerCase().trim() : '';
    const limit = Math.min(Number(req.query.limit) || 50, 100);

    let grants = loadCatalog();

    if (q) {
      grants = grants.filter(g => {
        const searchable = [
          g.opportunity_title,
          g.provider,
          g.description,
          g.category,
          ...(g.focus_areas ?? []),
          g.target_population,
          g.notes,
        ].join(' ').toLowerCase();
        return q.split(' ').every(term => searchable.includes(term));
      });
    }

    if (category) {
      grants = grants.filter(g => g.category.toLowerCase().includes(category));
    }

    const normalized = grants.slice(0, limit).map(normalizeCatalogGrant);
    res.json({ data: normalized, total: normalized.length, source: 'catalog' });
  } catch (err) {
    console.error('Catalog error:', err);
    res.status(500).json({ error: 'Failed to load catalog' });
  }
});

const PORT = Number(process.env.PORT) || 3001;
app.listen(PORT, () => {
  console.log(`Grant chat API listening on http://localhost:${PORT}`);
});