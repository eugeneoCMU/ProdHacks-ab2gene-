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
import type { FeatureExtractionPipeline, Tensor } from '@huggingface/transformers';

/** Default: ONNX MiniLM (384-d). Override with RAG_EMBEDDING_MODEL. First run downloads model weights. */
const RAG_EMBEDDING_MODEL =
  process.env.RAG_EMBEDDING_MODEL?.trim() || 'onnx-community/all-MiniLM-L6-v2-ONNX';
/** Set RAG_EMBEDDINGS_DISABLED=1 on tiny serverless bundles (e.g. strict size limits); chunk text + insert still works without vectors. */
const RAG_EMBEDDINGS_DISABLED =
  process.env.RAG_EMBEDDINGS_DISABLED === '1' || /^true$/i.test(process.env.RAG_EMBEDDINGS_DISABLED ?? '');

let embeddingExtractorPromise: Promise<FeatureExtractionPipeline> | null = null;

function rowsFromEmbeddingTensor(tensor: Tensor): number[][] {
  const dims = tensor.dims;
  const nested = tensor.tolist() as unknown;
  if (dims.length === 1) {
    const row = nested as number[];
    return [row.map((x) => Number(x))];
  }
  if (dims.length === 2) {
    const outer = nested as unknown[];
    return outer.map((row) =>
      Array.isArray(row) ? row.map((x) => Number(x)) : [Number(row)]
    );
  }
  return [];
}

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.VITE_SUPABASE_ANON_KEY || '';
let supabaseAdmin: SupabaseClient | null = null;
const hasValidSupabaseUrl = (() => {
  try {
    return !!SUPABASE_URL && /^https?:\/\//i.test(SUPABASE_URL) && Boolean(new URL(SUPABASE_URL));
  } catch {
    return false;
  }
})();
if (hasValidSupabaseUrl && SUPABASE_ANON_KEY) {
  supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
if (!OPENAI_API_KEY) {
  console.error(
    'Missing OPENAI API key.'
  );
  process.exit(1);
}
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
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
  /** Supabase session access_token — used to read document_chunks under RLS and run embedding retrieval */
  accessToken?: unknown;
}

interface AutofillFieldRequestBody {
  questionText?: unknown;
  fieldKey?: unknown;
  descriptor?: unknown;
  tagName?: unknown;
  inputType?: unknown;
  pageTitle?: unknown;
  pageUrl?: unknown;
  organizationProfile?: unknown;
  grantContext?: unknown;
  userId?: unknown;
}

function buildSystemInstruction(
  grantContext: string,
  retrievedDocumentChunks?: string
): string {
  let out = RAG_SYSTEM_INSTRUCTION;
  if (retrievedDocumentChunks?.trim()) {
    out += `Relevant excerpts from your organization's uploaded documents (retrieved for this question):\n${retrievedDocumentChunks.trim()}\n\n`;
  }
  out += `Grant opportunity (use for deadlines, eligibility, amounts, etc.):\n${grantContext}`;
  return out;
}

function isNonAutofillField(fieldKey: string, inputType: string, tagName: string): boolean {
  const blockedKeys = new Set([
    'password',
    'confirm_password',
    'username',
    'birth_month',
    'birth_day',
    'unknown'
  ]);

  if (blockedKeys.has(fieldKey)) {
    return true;
  }

  return inputType === 'checkbox' || inputType === 'radio' || inputType === 'password' || tagName === 'button';
}

function parseEmbeddingColumn(raw: unknown): number[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw) && raw.every((x) => typeof x === 'number')) {
    return raw as number[];
  }
  if (typeof raw === 'string') {
    try {
      const s = raw.trim();
      const parsed = JSON.parse(s.startsWith('[') ? s : `[${s}]`) as unknown;
      if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'number')) {
        return parsed as number[];
      }
    } catch {
      return null;
    }
  }
  return null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/**
 * Embed the user question and return the top-K document chunks by cosine similarity.
 * Uses the user's JWT so RLS applies. Returns '' if no chunks/embeddings or no token.
 */
async function retrieveRelevantChunksForQuery(accessToken: string, userQuery: string): Promise<string> {
  const q = userQuery.trim();
  if (!q) return '';

  const userClient = createUserSupabaseClient(accessToken);
  if (!userClient) return '';

  const { data: authData, error: authErr } = await userClient.auth.getUser();
  if (authErr || !authData.user) return '';

  const userId = authData.user.id;
  const { data: rows, error } = await userClient
    .from('document_chunks')
    .select('content, embedding, source_info')
    .eq('user_id', userId);

  if (error || !rows?.length) {
    if (error) console.warn('RAG chat: document_chunks select failed:', error.message);
    return '';
  }

  const withEmb: Array<{ content: string; embedding: number[]; source?: string }> = [];
  for (const r of rows) {
    const emb = parseEmbeddingColumn(r.embedding);
    const content = typeof r.content === 'string' ? r.content.trim() : '';
    if (!emb?.length || !content) continue;
    const fn = (r.source_info as { filename?: string } | null)?.filename;
    withEmb.push({ content, embedding: emb, source: fn });
  }

  if (!withEmb.length) return '';

  let queryEmbedding: number[] | undefined;
  try {
    const result = await embedTextsWithTransformers([q]);
    queryEmbedding = result?.[0];
  } catch (e) {
    console.warn('RAG chat: query embedding failed:', e);
  }
  if (!queryEmbedding) return '';

  const topK = Number(process.env.RAG_CHAT_TOP_K) || 8;
  const maxChars = Number(process.env.RAG_CHAT_MAX_CHUNK_CHARS) || 12000;

  const scored = withEmb
    .map((row) => ({ ...row, score: cosineSimilarity(queryEmbedding, row.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  const blocks: string[] = [];
  for (const row of scored) {
    const block = row.source ? `[${row.source}]\n${row.content}` : row.content;
    if (block.trim()) blocks.push(block.trim());
  }

  let joined = blocks.join('\n\n---\n\n');
  if (joined.length > maxChars) {
    joined = `${joined.slice(0, maxChars)}…`;
  }
  return joined;
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

const CHUNK_CHAR_SIZE = Number(process.env.RAG_CHUNK_CHAR_SIZE) || 1500;
const CHUNK_OVERLAP = Number(process.env.RAG_CHUNK_OVERLAP) || 200;

const RAG_EMBEDDING_BATCH_SIZE = Math.max(
  1,
  Math.min(32, Number(process.env.RAG_EMBEDDING_BATCH_SIZE) || 8)
);

async function loadEmbeddingExtractor(): Promise<FeatureExtractionPipeline> {
  if (embeddingExtractorPromise) return embeddingExtractorPromise;
  embeddingExtractorPromise = (async () => {
    const { pipeline } = await import('@huggingface/transformers');
    console.info(`RAG: loading embedding model "${RAG_EMBEDDING_MODEL}"…`);
    return pipeline('feature-extraction', RAG_EMBEDDING_MODEL) as Promise<FeatureExtractionPipeline>;
  })().catch((err) => {
    embeddingExtractorPromise = null;
    throw err;
  });
  return embeddingExtractorPromise;
}

/** Mean-pooled, L2-normalized embeddings via Hugging Face Transformers.js (ONNX). Returns null if disabled or model load fails. */
async function embedTextsWithTransformers(texts: string[]): Promise<number[][] | null> {
  if (RAG_EMBEDDINGS_DISABLED) return null;
  if (!texts.length) return [];

  try {
    const extractor = await loadEmbeddingExtractor();
    const result: number[][] = texts.map(() => []);

    for (let start = 0; start < texts.length; start += RAG_EMBEDDING_BATCH_SIZE) {
      const end = Math.min(start + RAG_EMBEDDING_BATCH_SIZE, texts.length);
      const batchIdx: number[] = [];
      const batchStr: string[] = [];
      for (let i = start; i < end; i++) {
        const t = texts[i]?.trim() ?? '';
        if (t) {
          batchIdx.push(i);
          batchStr.push(t);
        }
      }
      if (!batchStr.length) continue;

      const tensor = await extractor(batchStr, { pooling: 'mean', normalize: true });
      const rows = rowsFromEmbeddingTensor(tensor);
      if (rows.length !== batchStr.length) {
        console.warn(
          `RAG: embedding batch shape mismatch (got ${rows.length} rows, expected ${batchStr.length})`
        );
        return null;
      }
      for (let j = 0; j < batchIdx.length; j++) {
        result[batchIdx[j]] = rows[j] ?? [];
      }
    }

    return result;
  } catch (e) {
    console.warn('embedTextsWithTransformers:', e);
    return null;
  }
}

/** Sliding-window text chunks for embedding + RAG. */
function splitTextIntoChunks(text: string, chunkSize: number, overlap: number): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= chunkSize) return [t];
  const chunks: string[] = [];
  let i = 0;
  while (i < t.length) {
    const slice = t.slice(i, i + chunkSize);
    const trimmed = slice.trim();
    if (trimmed) chunks.push(trimmed);
    if (i + chunkSize >= t.length) break;
    i += chunkSize - overlap;
  }
  return chunks;
}

function createUserSupabaseClient(accessToken: string): SupabaseClient | null {
  if (!hasValidSupabaseUrl || !SUPABASE_ANON_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

async function persistChunksAndEmbeddings(
  userClient: SupabaseClient,
  userId: string,
  documentId: string,
  filename: string,
  chunks: string[],
  embeddings: number[][] | null
): Promise<void> {
  // const { error: delErr } = await userClient.from('document_chunks').delete().eq('document_id', documentId);
  // if (delErr) throw new Error(`Failed to clear old chunks: ${delErr.message}`);

  const batchSize = 50;
  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const slice = chunks.slice(offset, offset + batchSize);
    const rows = slice.map((content, j) => {
      const chunk_index = offset + j;
      const row: {
        user_id: string;
        document_id: string;
        chunk_index: number;
        content: string;
        source_info: Record<string, unknown>;
        embedding?: number[];
      } = {
        user_id: userId,
        document_id: documentId,
        chunk_index,
        content,
        source_info: { filename, source: 'extract-documents' },
      };
      if (embeddings?.[chunk_index]?.length) {
        row.embedding = embeddings[chunk_index];
      }
      return row;
    });

    const { error: insErr } = await userClient.from('document_chunks').insert(rows);
    if (insErr) throw new Error(`document_chunks insert failed: ${insErr.message}`);
  }

  const { error: upErr } = await userClient
    .from('documents')
    .update({ status: 'ready' })
    .eq('id', documentId)
    .eq('user_id', userId);
  if (upErr) throw new Error(`documents status update failed: ${upErr.message}`);
}

/** Generate one grant-application answer using Gemini from context and question. */
async function generateAnswerForQuestion(context: string, question: string, wordLimit?: number): Promise<string> {
  const instructions = RAG_SYSTEM_INSTRUCTION + (wordLimit ? ` Keep your answer within ${wordLimit} words.` : '');
  const prompt = `Context from the organization's documents and profile:\n\n${context}\n\nQuestion to answer:\n${question}\n\nProvide a direct, concise answer suitable for pasting into a grant form.`;
  return await generateModelText(instructions, prompt);
}

async function generateAutofillAnswer(options: {
  organizationContext: string;
  grantContext: string;
  questionText: string;
  fieldKey: string;
  descriptor: string;
  tagName: string;
  inputType: string;
  pageTitle: string;
  pageUrl: string;
}): Promise<{ answer: string; confidence: 'high' | 'medium' | 'low'; rationale: string; normalizedFieldKey: string; }> {
  const {
    organizationContext,
    grantContext,
    questionText,
    fieldKey,
    descriptor,
    tagName,
    inputType,
    pageTitle,
    pageUrl,
  } = options;

  if (isNonAutofillField(fieldKey, inputType, tagName)) {
    return {
      answer: '',
      confidence: 'low',
      rationale: 'Skipped because this field should not be auto-filled.',
      normalizedFieldKey: fieldKey || 'unknown',
    };
  }

  const instructions = `${RAG_SYSTEM_INSTRUCTION}

You are generating one auto-fill value for a grant portal field.
Return strict JSON only with keys: normalizedFieldKey, answer, confidence, rationale.
- normalizedFieldKey must be snake_case.
- confidence must be one of high, medium, low.
- rationale should be one short sentence.
- answer should be ready to paste into the field.
- For short text inputs, keep the answer short.
- For textarea questions, answer in one concise paragraph.
- If the field should not be auto-filled or the context is insufficient, return answer as an empty string and confidence as low.`;

  const prompt = `Field key guess: ${fieldKey || 'unknown'}
Field question or label:
${questionText}

Descriptor:
${descriptor || 'n/a'}

HTML tag / input type:
${tagName} / ${inputType}

Page title:
${pageTitle || 'n/a'}

Page URL:
${pageUrl || 'n/a'}

Grant context:
${grantContext || 'n/a'}

Organization profile context:
${organizationContext}
`;

  const raw = await generateModelText(instructions, prompt);
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    const parsed = JSON.parse(cleaned) as {
      normalizedFieldKey?: string;
      answer?: string;
      confidence?: 'high' | 'medium' | 'low';
      rationale?: string;
    };

    return {
      normalizedFieldKey: parsed.normalizedFieldKey?.trim() || fieldKey || 'unknown',
      answer: parsed.answer?.trim() || '',
      confidence: parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low'
        ? parsed.confidence
        : 'low',
      rationale: parsed.rationale?.trim() || 'No rationale returned.',
    };
  } catch {
    return {
      normalizedFieldKey: fieldKey || 'unknown',
      answer: cleaned,
      confidence: cleaned ? 'medium' : 'low',
      rationale: 'Model response could not be parsed as JSON, so fallback text was used.',
    };
  }
}

async function generateOpenAIText(instructions: string, messages: Array<{ role: 'developer' | 'user' | 'assistant'; content: string }>): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'developer', content: instructions },
        ...messages,
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`OpenAI request failed: ${response.status} ${errorBody}`.trim());
  }

  const json = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  return json.choices?.[0]?.message?.content?.trim() || '';
}

async function generateModelText(
  instructions: string,
  prompt: string,
  history: Array<{ role: 'user' | 'model'; content: string }> = []
): Promise<string> {
  const messages = [
    ...history.map((message) => ({
      role: message.role === 'model' ? 'assistant' as const : 'user' as const,
      content: message.content,
    })),
    { role: 'user' as const, content: prompt },
  ];
  return await generateOpenAIText(instructions, messages);
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

/** Extract text from PDF using unpdf (works in Node.js and serverless without DOM). */
async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const { extractText } = await import('unpdf');
  const result = await extractText(new Uint8Array(buffer));
  const text = result.text;
  return Array.isArray(text) ? text.join('\n\n') : (text ?? '');
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
 * Multipart form with "files" (array of files). Returns { text: string, chunksInserted?: number }.
 * Optional: field "documentIds" = JSON array of document UUIDs (same order as files), and
 * Authorization: Bearer <access_token> — required together to persist chunks + embeddings to Supabase.
 */
app.post('/api/extract-documents', upload.array('files', 20), async (req: Request, res: Response): Promise<void> => {
  try {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files?.length) {
      res.status(400).json({ error: 'No files uploaded. Send multipart form with field "files".' });
      return;
    }

    let documentIds: string[] | undefined;
    const rawIds = req.body?.documentIds;
    if (typeof rawIds === 'string' && rawIds.trim()) {
      try {
        const parsed = JSON.parse(rawIds) as unknown;
        if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string' && x.length > 0)) {
          documentIds = parsed as string[];
        }
      } catch {
        /* ignore invalid JSON */
      }
    }

    const authHeader = req.headers.authorization;
    const accessToken =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : '';

    const parts: string[] = [];
    let chunksInserted = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const text = await extractTextFromFile(file.buffer, file.mimetype, file.originalname);
      const trimmed = text.trim();
      if (trimmed) {
        parts.push(`--- ${file.originalname} ---\n${trimmed}`);
      }

      const docId = documentIds?.[i];
      const canPersist =
        Boolean(accessToken && docId && trimmed && documentIds?.length === files.length);

      if (!canPersist) {
        continue;
      }

      const userClient = createUserSupabaseClient(accessToken);
      if (!userClient) {
        continue;
      }

      const { data: authData, error: authErr } = await userClient.auth.getUser();
      if (authErr || !authData.user) {
        console.warn('extract-documents: invalid session for chunk persist:', authErr?.message);
        continue;
      }

      const userId = authData.user.id;

      try {
        const chunks = splitTextIntoChunks(trimmed, CHUNK_CHAR_SIZE, CHUNK_OVERLAP);
        if (!chunks.length) continue;

        const embeddings = await embedTextsWithTransformers(chunks);

        await persistChunksAndEmbeddings(userClient, userId, docId!, file.originalname, chunks, embeddings);
        chunksInserted += chunks.length;
      } catch (persistErr) {
        console.error('extract-documents: persist chunks failed:', persistErr);
        throw persistErr;
      }
    }

    res.json({ text: parts.join('\n\n'), chunksInserted });
  } catch (err) {
    console.error('Extract error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to extract text from documents',
    });
  }
});

/** POST /api/chat
 * Body: { grantContext: string, profileContext?: string, messages: ChatMessage[], accessToken?: string }
 * When accessToken is the user's Supabase JWT, document knowledge comes from embedding retrieval over document_chunks (not the full profile text).
 * Returns: { reply: string }
 */
app.post('/api/chat', async (req: Request, res: Response): Promise<void> => {
  try {
    const { grantContext, messages, accessToken: bodyToken } = req.body as ChatRequestBody;
    if (!grantContext || typeof grantContext !== 'string') {
      res.status(400).json({ error: 'grantContext is required and must be a string' });
      return;
    }
    if (!Array.isArray(messages)) {
      res.status(400).json({ error: 'messages must be an array' });
      return;
    }
    const authHeader = req.headers.authorization;
    const tokenFromHeader =
      typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : '';
    const tokenFromBody = typeof bodyToken === 'string' ? bodyToken.trim() : '';
    const accessToken = tokenFromHeader || tokenFromBody;

    const valid = (messages as ChatMessage[]).filter((m) => m.role && m.content);
    const lastMessage = valid[valid.length - 1];
    const toSend =
      lastMessage?.role === 'user'
        ? lastMessage.content
        : 'Say you are ready to answer questions about this grant.';
    const priorHistory = valid.slice(0, -1).map((m) => ({
      role: (m.role === 'model' ? 'model' : 'user') as 'user' | 'model',
      content: m.content,
    }));

    let retrievedChunks = '';

    if (accessToken) {
      try {
        retrievedChunks = await retrieveRelevantChunksForQuery(accessToken, toSend);
      } catch (ragErr) {
        console.warn('RAG chat: retrieveRelevantChunksForQuery failed:', ragErr);
      }
    }

    const text = await generateModelText(
      buildSystemInstruction(grantContext, retrievedChunks || undefined),
      toSend,
      priorHistory
    );

    res.json({ reply: text ?? '' });
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

app.post('/api/autofill-field', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      questionText,
      fieldKey = '',
      descriptor = '',
      tagName = '',
      inputType = '',
      pageTitle = '',
      pageUrl = '',
      organizationProfile = '',
      grantContext = '',
      userId = '',
    } = req.body as AutofillFieldRequestBody;

    if (!questionText || typeof questionText !== 'string' || !questionText.trim()) {
      res.status(400).json({ error: 'questionText is required and must be a string' });
      return;
    }

    let organizationContext = typeof organizationProfile === 'string' ? organizationProfile.trim() : '';
    if (typeof userId === 'string' && userId.trim() && supabaseAdmin) {
      const docContext = await fetchUserDocumentContext(userId.trim());
      if (docContext) {
        organizationContext = organizationContext
          ? `${organizationContext}\n\n--- Documents from Supabase ---\n\n${docContext}`
          : docContext;
      }
    }

    if (!organizationContext) {
      res.status(400).json({ error: 'organizationProfile or user document context is required' });
      return;
    }

    const result = await generateAutofillAnswer({
      organizationContext,
      grantContext: typeof grantContext === 'string' ? grantContext.trim() : '',
      questionText: questionText.trim(),
      fieldKey: typeof fieldKey === 'string' ? fieldKey.trim() : '',
      descriptor: typeof descriptor === 'string' ? descriptor.trim() : '',
      tagName: typeof tagName === 'string' ? tagName.trim() : '',
      inputType: typeof inputType === 'string' ? inputType.trim() : '',
      pageTitle: typeof pageTitle === 'string' ? pageTitle.trim() : '',
      pageUrl: typeof pageUrl === 'string' ? pageUrl.trim() : '',
    });

    res.json(result);
  } catch (err) {
    console.error('Autofill field error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to generate autofill answer',
    });
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

// IRS BMF lookup tables for decoding raw codes into human-readable descriptions
const NTEE_DESCRIPTIONS: Record<string, string> = {
  A: 'Arts, Culture & Humanities', B: 'Education', C: 'Environment',
  D: 'Animal-Related', E: 'Health Care', F: 'Mental Health & Crisis Intervention',
  G: 'Disease, Disorders & Medical Disciplines', H: 'Medical Research',
  I: 'Crime & Legal-Related', J: 'Employment', K: 'Food, Agriculture & Nutrition',
  L: 'Housing & Shelter', M: 'Public Safety, Disaster Preparedness & Relief',
  N: 'Recreation & Sports', O: 'Youth Development', P: 'Human Services',
  Q: 'International, Foreign Affairs & National Security', R: 'Civil Rights & Advocacy',
  S: 'Community Improvement & Capacity Building', T: 'Philanthropy & Voluntarism',
  U: 'Science & Technology', V: 'Social Science', W: 'Public & Societal Benefit',
  X: 'Religion-Related', Y: 'Mutual & Membership Benefit', Z: 'Unknown',
};

const SUBSECTION_DESCRIPTIONS: Record<string, string> = {
  '2': '501(c)(2) — Title Holding Corporation',
  '3': '501(c)(3) — Charitable, Educational, Religious, or Scientific',
  '4': '501(c)(4) — Social Welfare Organization',
  '5': '501(c)(5) — Labor, Agricultural & Horticultural',
  '6': '501(c)(6) — Business League / Trade Association',
  '7': '501(c)(7) — Social & Recreational Club',
  '8': '501(c)(8) — Fraternal Beneficiary Society',
  '9': '501(c)(9) — Voluntary Employee Benefit Association',
  '10': '501(c)(10) — Domestic Fraternal Society',
  '19': '501(c)(19) — Veterans Organization',
};

const FOUNDATION_DESCRIPTIONS: Record<string, string> = {
  '0': 'Not a Private Foundation',
  '2': 'Private Operating Foundation',
  '3': 'Private Foundation (General)',
  '4': 'Private Foundation (Exempt from Excise Tax)',
  '10': 'Church',
  '11': 'School',
  '12': 'Hospital or Medical Research Organization',
  '13': 'Organization Supporting Government',
  '14': 'Publicly Supported Organization (509(a)(1))',
  '15': 'Publicly Supported Organization (509(a)(2))',
  '16': 'Supporting Organization',
  '17': 'Community Trust',
  '18': 'Publicly Supported Organization (170(b)(1)(A)(vi))',
};

/** POST /api/ein-lookup
 * Body: { ein: string }
 * Fetches org info from ProPublica (IRS BMF + 990s) and USASpending.gov (past federal grants).
 * Returns: { orgName, text }
 */
app.post('/api/ein-lookup', async (req: Request, res: Response): Promise<void> => {
  try {
    const ein = typeof req.body.ein === 'string' ? req.body.ein.replace(/\D/g, '') : '';
    if (!ein || ein.length !== 9) {
      res.status(400).json({ error: 'A valid 9-digit EIN is required.' });
      return;
    }

    const proPublicaRes = await fetch(
      `https://projects.propublica.org/nonprofits/api/v2/organizations/${ein}.json`
    );
    if (proPublicaRes.status === 404) {
      res.status(404).json({ error: 'No nonprofit found for that EIN. Make sure it is a registered 501(c)(3).' });
      return;
    }
    if (!proPublicaRes.ok) {
      res.status(502).json({ error: 'Failed to reach ProPublica Nonprofit Explorer. Try again later.' });
      return;
    }

    const data = await proPublicaRes.json() as {
      organization?: {
        name?: string;
        city?: string;
        state?: string;
        ntee_code?: string;
        subsection_code?: string;
        foundation_code?: string;
        ruling_date?: string;
        deductibility_code?: number;
        asset_amount?: number;
        income_amount?: number;
        revenue_amount?: number;
      };
      filings_with_data?: Array<{
        tax_prd_yr?: number;
        totrevenue?: number;
        totfuncexpns?: number;
        totassetsend?: number;
        pdf_url?: string;
      }>;
    };

    const org = data.organization;
    if (!org?.name) {
      res.status(404).json({ error: 'Organization data not found for that EIN.' });
      return;
    }

    // --- Section 1: IRS BMF (decoded from ProPublica) ---
    const parts: string[] = ['=== IRS Business Master File (BMF) ==='];
    parts.push(`Organization Name: ${org.name}`);
    if (org.city && org.state) parts.push(`Location: ${org.city}, ${org.state}`);

    const nteeCategory = org.ntee_code ? org.ntee_code.charAt(0).toUpperCase() : '';
    if (org.ntee_code) {
      const nteeDesc = NTEE_DESCRIPTIONS[nteeCategory] ?? 'Unknown';
      parts.push(`Mission Category (NTEE): ${org.ntee_code} — ${nteeDesc}`);
    }
    if (org.subsection_code) {
      const subDesc = SUBSECTION_DESCRIPTIONS[String(org.subsection_code)] ?? `501(c)(${org.subsection_code})`;
      parts.push(`Tax-Exempt Status: ${subDesc}`);
    }
    if (org.foundation_code) {
      const foundDesc = FOUNDATION_DESCRIPTIONS[String(org.foundation_code)] ?? `Foundation Code ${org.foundation_code}`;
      parts.push(`Foundation Type: ${foundDesc}`);
    }
    if (org.ruling_date) parts.push(`IRS Ruling Date: ${org.ruling_date}`);
    if (org.deductibility_code === 1) parts.push('Tax Deductibility: Contributions are deductible');
    if (org.revenue_amount) parts.push(`Total Revenue: $${org.revenue_amount.toLocaleString()}`);
    if (org.asset_amount) parts.push(`Total Assets: $${org.asset_amount.toLocaleString()}`);

    // --- Section 2: IRS 990 Filings ---
    const recentFilings = (data.filings_with_data ?? []).slice(0, 3);
    if (recentFilings.length > 0) {
      parts.push('\n=== IRS 990 Filing Summaries ===');
      for (const f of recentFilings) {
        const lines = [`  Year: ${f.tax_prd_yr ?? 'Unknown'}`];
        if (f.totrevenue) lines.push(`  Total Revenue: $${f.totrevenue.toLocaleString()}`);
        if (f.totfuncexpns) lines.push(`  Total Expenses: $${f.totfuncexpns.toLocaleString()}`);
        if (f.totassetsend) lines.push(`  Total Assets (End of Year): $${f.totassetsend.toLocaleString()}`);
        parts.push(lines.join('\n'));
      }
    }

    // --- Section 3: USASpending.gov — past federal grants ---
    let usaSpendingSearchName = org.name;
    try {
      const acRes = await fetch('https://api.usaspending.gov/api/v2/autocomplete/recipient/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ search_text: org.name, limit: 1 }),
        signal: AbortSignal.timeout(5000),
      });
      if (acRes.ok) {
        const acData = await acRes.json() as { results?: Array<{ recipient_name?: string }> };
        const normalizedName = acData.results?.[0]?.recipient_name;
        if (normalizedName) usaSpendingSearchName = normalizedName;
      }
    } catch { /* fall back to org.name */ }

    const usaSpendingData = await fetch('https://api.usaspending.gov/api/v2/search/spending_by_award/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filters: {
          award_type_codes: ['02', '03', '04', '05'],
          recipient_search_text: [usaSpendingSearchName],
        },
        fields: ['Award ID', 'Recipient Name', 'Award Amount', 'Awarding Agency', 'Start Date', 'Description', 'CFDA Number', 'CFDA Title'],
        page: 1,
        limit: 10,
        sort: 'Award Amount',
        order: 'desc',
      }),
    })
      .then(async (r) => {
        if (!r.ok) return null;
        return r.json() as Promise<{
          results?: Array<{
            'Award ID'?: string;
            'Recipient Name'?: string;
            'Award Amount'?: number;
            'Awarding Agency'?: string;
            'Start Date'?: string;
            'Description'?: string;
            'CFDA Number'?: string;
            'CFDA Title'?: string;
          }>;
        }>;
      })
      .catch(() => null);

    const awards = usaSpendingData?.results ?? [];
    if (awards.length > 0) {
      parts.push('\n=== USASpending.gov — Past Federal Grants ===');
      parts.push(`(${awards.length} federal grant(s) found — indicates eligibility for similar programs)`);
      for (const award of awards) {
        const lines: string[] = [];
        if (award['Awarding Agency']) lines.push(`  Agency: ${award['Awarding Agency']}`);
        if (award['CFDA Number'] && award['CFDA Title']) lines.push(`  Program: ${award['CFDA Title']} (CFDA ${award['CFDA Number']})`);
        else if (award['CFDA Number']) lines.push(`  CFDA: ${award['CFDA Number']}`);
        if (award['Award Amount']) lines.push(`  Amount: $${award['Award Amount'].toLocaleString()}`);
        if (award['Start Date']) lines.push(`  Start Date: ${award['Start Date']}`);
        if (award['Description']) lines.push(`  Description: ${award['Description']}`);
        parts.push(lines.join('\n'));
      }
    } else {
      parts.push('\n=== USASpending.gov ===\nNo prior federal grant awards found. Organization may be new or primarily privately funded.');
    }

    res.json({ orgName: org.name, text: parts.join('\n') });
  } catch (err) {
    console.error('EIN lookup error:', err);
    res.status(500).json({ error: err instanceof Error ? err.message : 'EIN lookup failed' });
  }
});

const PORT = Number(process.env.PORT) || 3001;
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Grant chat API listening on http://localhost:${PORT}`);
  });
}

export default app;
