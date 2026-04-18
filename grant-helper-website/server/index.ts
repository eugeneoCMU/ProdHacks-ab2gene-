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
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!OPENAI_API_KEY && !GEMINI_API_KEY) {
  console.error(
    'Missing API key. Add OPENAI_API_KEY=your_key or GEMINI_API_KEY=your_key to grant-helper-website/.env.'
  );
  process.exit(1);
}

const genAI = GEMINI_API_KEY ? new GoogleGenerativeAI(GEMINI_API_KEY) : null;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

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
  role: 'user' | 'model';
  content: string;
}

interface ChatRequestBody {
  grantContext?: unknown;
  profileContext?: unknown;
  messages?: unknown;
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

interface AutofillFieldCandidate {
  index?: unknown;
  fieldKey?: unknown;
  questionText?: unknown;
  descriptor?: unknown;
  tagName?: unknown;
  inputType?: unknown;
}

interface AutofillFieldsRequestBody {
  fields?: unknown;
  pageTitle?: unknown;
  pageUrl?: unknown;
  organizationProfile?: unknown;
  grantContext?: unknown;
  userId?: unknown;
}

interface ProfileStructuringRequestBody {
  organizationProfile?: unknown;
  userId?: unknown;
}

function getFieldSpecificGuidance(fieldKey: string): string {
  switch (fieldKey) {
    case 'contact_name':
      return 'Expect a full person name. If only one name token is known, leave blank instead of inventing the rest.';
    case 'first_name':
      return 'Expect only the given name of a person.';
    case 'last_name':
      return 'Expect only the family name of a person. Do not use street, address, role, or organization words.';
    case 'job_title':
      return 'Expect a short professional role such as Executive Director or Program Manager. Leave blank if not explicit.';
    case 'email':
      return 'Expect a valid email address only. Confirmation and re-entry email fields should reuse that same address.';
    case 'phone':
    case 'mobile_phone':
      return 'Expect a phone number only. Return digits or standard US formatting, not address text.';
    case 'website':
      return 'Expect an organization website URL or domain only.';
    case 'address_line_1':
      return 'Expect the street portion of an address only, not city/state/zip.';
    case 'address_line_2':
      return 'Expect only suite, unit, apartment, or secondary address information.';
    case 'city':
      return 'Expect a city or locality only, with no digits.';
    case 'state':
      return 'Expect a state or province only, typically a two-letter US abbreviation when applicable.';
    case 'zip':
      return 'Expect only a ZIP or postal code.';
    case 'country':
      return 'Expect only a country name.';
    case 'organization_name':
      return 'Expect the legal or common organization name only.';
    case 'project_title':
      return 'Expect a short, descriptive project or program title. If not explicit, you may synthesize a truthful title grounded in the mission and activities.';
    case 'need_statement':
      return 'Explain the specific problem, why it matters now, and why funding is needed. Use full sentences and make the urgency clear without exaggeration.';
    case 'target_population':
      return 'Explain who benefits, how the organization identifies them, and how it reaches or recruits them. Use full sentences, not a short fragment.';
    case 'organizational_capacity':
      return 'Explain what makes the organization or program effective compared with other approaches. Use full sentences and cite relevant strengths from the context.';
    case 'mission_statement':
    case 'organization_description':
    case 'organization_history':
    case 'project_summary':
    case 'project_abstract':
    case 'project_goals':
    case 'geographic_area_served':
    case 'program_description':
    case 'impact_statement':
    case 'outcomes':
    case 'evaluation_plan':
    case 'sustainability_plan':
    case 'implementation_timeline':
    case 'methods_approach':
    case 'staffing_plan':
    case 'partnerships':
    case 'dei_statement':
    case 'financial_need':
    case 'board_governance':
    case 'success_metrics':
      return 'This is a narrative-style field. Draft a polished, professional response in full sentences. Address every part of the question, not just the opening phrase, and expand enough to be useful in a grant application.';
    default:
      return '';
  }
}

function buildSystemInstruction(profileContext: string, grantContext: string): string {
  let out = RAG_SYSTEM_INSTRUCTION;
  if (profileContext.trim()) {
    out += `Applicant / organization profile (base context):\n${profileContext.trim()}\n\n`;
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

const STRUCTURED_PROFILE_KEYS = [
  'organization_name',
  'contact_name',
  'first_name',
  'last_name',
  'email',
  'phone',
  'mobile_phone',
  'website',
  'job_title',
  'ein',
  'uei',
  'duns',
  'address_line_1',
  'address_line_2',
  'city',
  'state',
  'zip',
  'country',
  'mission_statement',
  'organization_description',
  'organization_history',
  'target_population',
  'geographic_area_served',
  'year_founded',
] as const;

const AI_OPTIONAL_STRUCTURED_KEYS = new Set([
  'mission_statement',
  'organization_description',
  'organization_history',
  'target_population',
  'geographic_area_served',
  'year_founded',
]);

type StructuredProfile = Record<(typeof STRUCTURED_PROFILE_KEYS)[number], string>;

interface ResolvedOrganizationContext {
  organizationContext: string;
  documentContextUsed: boolean;
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

async function resolveOrganizationContext(organizationProfile: unknown, userId: unknown): Promise<ResolvedOrganizationContext> {
  let organizationContext = typeof organizationProfile === 'string' ? organizationProfile.trim() : '';
  let documentContextUsed = false;

  if (typeof userId === 'string' && userId.trim() && supabaseAdmin) {
    const docContext = await fetchUserDocumentContext(userId.trim());
    if (docContext) {
      organizationContext = organizationContext
        ? `${organizationContext}\n\n--- Documents from Supabase ---\n\n${docContext}`
        : docContext;
      documentContextUsed = true;
    }
  }

  return { organizationContext, documentContextUsed };
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
- For textarea questions, answer in full sentences and address every part of the prompt.
- When the question asks multiple things, cover each one clearly in the same answer.
- For narrative questions, prefer 2-5 complete sentences unless the prompt clearly needs something shorter.
- Do not guess a person's first or last name from an organization name.
- For factual identity fields, only answer if the value is explicitly present in context.
- Treat contact, email, phone, website, address, city, state, zip, country, EIN, UEI, DUNS, and job title as factual fields.
- You may only synthesize new wording for narrative fields and project_title.
- If fieldKey is project_title and the organization context clearly describes a program or mission but no explicit title exists, you may create a short, truthful 3-8 word title grounded in that mission.
- If the field asks to confirm or re-enter an email/phone value, return the same explicit factual value only if it is present in context.
- If the field should not be auto-filled or the context is insufficient, return answer as an empty string and confidence as low.
- If you are unsure, leave the answer blank.`;

  const fieldSpecificGuidance = getFieldSpecificGuidance(fieldKey);
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

Field-specific guidance:
${fieldSpecificGuidance || 'No additional guidance.'}

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
      answer: '',
      confidence: 'low',
      rationale: 'Model response could not be parsed safely, so the field was left blank.',
    };
  }
}

async function structureOrganizationProfile(context: string): Promise<StructuredProfile> {
  const emptyProfile = Object.fromEntries(STRUCTURED_PROFILE_KEYS.map((key) => [key, ''])) as StructuredProfile;
  const heuristicProfile = extractStructuredProfileHeuristics(context);

  const instructions = `Extract structured grant profile fields from the provided organization context.
Return strict JSON only.
Rules:
- Use only the keys provided below.
- If a value is not explicit, return an empty string.
- Do not infer first_name or last_name from organization_name.
- Keep values concise and factual.
Keys:
${STRUCTURED_PROFILE_KEYS.join(', ')}`;

  const prompt = `Organization context:
${context}`;

  try {
    const raw = await generateModelText(instructions, prompt);
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleaned) as Partial<StructuredProfile>;
    for (const key of STRUCTURED_PROFILE_KEYS) {
      const aiValue = typeof parsed[key] === 'string' ? parsed[key].trim() : '';
      emptyProfile[key] = heuristicProfile[key] || (AI_OPTIONAL_STRUCTURED_KEYS.has(key) ? aiValue : '') || '';
    }
  } catch {
    for (const key of STRUCTURED_PROFILE_KEYS) {
      emptyProfile[key] = heuristicProfile[key] || '';
    }
    return emptyProfile;
  }

  return emptyProfile;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function capturePattern(text: string, patterns: RegExp[]): string {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return normalizeWhitespace(match[1].replace(/^["']|["']$/g, ''));
    }
  }
  return '';
}

function splitContactName(fullName: string): { first: string; last: string } {
  const parts = normalizeWhitespace(fullName).split(' ').filter(Boolean);
  if (parts.length < 2) {
    return { first: '', last: '' };
  }
  return {
    first: parts[0],
    last: parts.slice(1).join(' '),
  };
}

function toTitleCaseName(value: string): string {
  return String(value || '')
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

function inferNameFromEmail(email: string): { first: string; last: string; full: string } {
  const trimmed = normalizeWhitespace(email);
  if (!/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(trimmed)) {
    return { first: '', last: '', full: '' };
  }

  const localPart = trimmed.split('@')[0];
  const parts = localPart
    .split(/[._-]+/)
    .map((part) => part.replace(/[^a-z]/gi, ''))
    .filter((part) => part.length >= 2);

  if (parts.length < 2) {
    return { first: '', last: '', full: '' };
  }

  const first = toTitleCaseName(parts[0]);
  const last = toTitleCaseName(parts.slice(1).join(' '));
  return {
    first,
    last,
    full: `${first} ${last}`.trim(),
  };
}

function parseAddressParts(address: string): Partial<StructuredProfile> {
  const parsed: Partial<StructuredProfile> = {};
  const clean = normalizeWhitespace(address.replace(/\baddress:\b/i, ''));
  if (!clean) {
    return parsed;
  }

  const cityStateZipMatch = clean.match(/^(.*?)(?:,\s*|\s+)([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)(?:\s+(United States|USA|US))?$/i);
  if (cityStateZipMatch) {
    const streetBlock = normalizeWhitespace(cityStateZipMatch[1]);
    const suiteMatch = streetBlock.match(/^(.*?)(?:\s+(suite|ste|unit|apt|apartment)\s+(.+))$/i);
    parsed.address_line_1 = normalizeWhitespace(suiteMatch ? suiteMatch[1] : streetBlock);
    parsed.address_line_2 = suiteMatch ? normalizeWhitespace(`${suiteMatch[2]} ${suiteMatch[3]}`) : '';
    parsed.city = normalizeWhitespace(cityStateZipMatch[2]);
    parsed.state = normalizeWhitespace(cityStateZipMatch[3]);
    parsed.zip = normalizeWhitespace(cityStateZipMatch[4]);
    parsed.country = normalizeWhitespace(cityStateZipMatch[5] || 'United States');
    return parsed;
  }

  const zipMatch = clean.match(/\b\d{5}(?:-\d{4})?\b/);
  const stateMatch = clean.match(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/);
  if (zipMatch) {
    parsed.zip = zipMatch[0];
  }
  if (stateMatch) {
    parsed.state = stateMatch[1];
  }

  const countryMatch = clean.match(/\b(United States|USA|US)\b/i);
  if (countryMatch) {
    parsed.country = countryMatch[1].toLowerCase() === 'us' ? 'United States' : normalizeWhitespace(countryMatch[1]);
  }

  const streetLeadMatch = clean.match(/^(\d+\s+[A-Za-z0-9.'# -]+?(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|terrace|ter|circle|cir)\b(?:\s+(?:suite|ste|unit|apt|apartment)\s+\S+)*)/i);
  if (streetLeadMatch) {
    const streetBlock = normalizeWhitespace(streetLeadMatch[1]);
    const suiteMatch = streetBlock.match(/^(.*?)(?:\s+(suite|ste|unit|apt|apartment)\s+(.+))$/i);
    parsed.address_line_1 = normalizeWhitespace(suiteMatch ? suiteMatch[1] : streetBlock);
    parsed.address_line_2 = suiteMatch ? normalizeWhitespace(`${suiteMatch[2]} ${suiteMatch[3]}`) : parsed.address_line_2 || '';
  }

  return parsed;
}

function extractStructuredProfileHeuristics(context: string): StructuredProfile {
  const profile = Object.fromEntries(STRUCTURED_PROFILE_KEYS.map((key) => [key, ''])) as StructuredProfile;
  const text = normalizeWhitespace(context);

  const emailMatch = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  const phoneMatch = text.match(/(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}/);
  const websiteMatch = text.match(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?\b/i);
  const einMatch = text.match(/\b\d{2}-\d{7}\b/);

  profile.organization_name = capturePattern(text, [
    /name of the nonprofit organization is ["']?([^".]+)["']?/i,
    /organization name[:\s]+["']?([^".]+)["']?/i,
    /legal name[:\s]+["']?([^".]+)["']?/i,
    /name[:\s]+["']?([^".]+(?:initiative|foundation|inc|corp|corporation|association|center|centre|organization|org))["']?/i,
  ]);

  const contactName = capturePattern(text, [
    /registered agent:\s*name:\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+)+)/i,
    /owner\s*\/\s*founder:\s*name:\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+)+)/i,
    /founder:\s*name:\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+)+)/i,
    /owner:\s*name:\s*([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+)+)/i,
    /incorporator[:\s]+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+)+)/i,
    /contact person[:\s]+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+)+)/i,
    /executive director[:\s]+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z.'-]+)+)/i,
  ]);

  if (contactName) {
    profile.contact_name = contactName;
    const split = splitContactName(contactName);
    profile.first_name = split.first;
    profile.last_name = split.last;
  }

  profile.job_title = capturePattern(text, [
    /title\s*\/\s*position[:\s]+([A-Za-z][A-Za-z\s/&-]{2,80})(?:\s{2,}|email:|phone:|$)/i,
    /job title[:\s]+([A-Za-z][A-Za-z\s/&-]{2,80})(?:\s{2,}|email:|phone:|$)/i,
    /position[:\s]+([A-Za-z][A-Za-z\s/&-]{2,80})(?:\s{2,}|email:|phone:|$)/i,
    /role[:\s]+([A-Za-z][A-Za-z\s/&-]{2,80})(?:\s{2,}|email:|phone:|$)/i,
  ]);

  if (emailMatch) {
    profile.email = emailMatch[0];
  }
  if (phoneMatch) {
    profile.phone = normalizeWhitespace(phoneMatch[0]);
    profile.mobile_phone = normalizeWhitespace(phoneMatch[0]);
  }
  if (websiteMatch && !websiteMatch[0].includes('@')) {
    profile.website = websiteMatch[0].startsWith('http') ? websiteMatch[0] : `https://${websiteMatch[0]}`;
  }
  if (einMatch) {
    profile.ein = einMatch[0];
  }

  const addressBlob = capturePattern(text, [
    /principal office address:\s*([^]+?)\s*(?:registered agent:|contact information:|board of directors:|$)/i,
    /mailing address:\s*([^]+?)\s*(?:registered agent:|contact information:|board of directors:|$)/i,
    /address:\s*([^]+?)\s*(?:phone:|email:|registered agent:|$)/i,
  ]);

  if (addressBlob) {
    const cleanAddress = normalizeWhitespace(addressBlob.replace(/\s*address:\s*/i, ''));
    const parsedAddress = parseAddressParts(cleanAddress);
    profile.address_line_1 = parsedAddress.address_line_1 || cleanAddress;
    profile.address_line_2 = parsedAddress.address_line_2 || '';
    profile.city = parsedAddress.city || '';
    profile.state = parsedAddress.state || '';
    profile.zip = parsedAddress.zip || '';
    profile.country = parsedAddress.country || '';
  }

  profile.mission_statement = capturePattern(text, [
    /purpose:\s*(.*?)(?:\s+\d+\.\s+[A-Z]|principal office address:|registered agent:|contact information:|$)/i,
  ]);

  if (profile.mission_statement && !profile.organization_description) {
    profile.organization_description = profile.mission_statement;
  }

  if (!profile.organization_history) {
    profile.organization_history = capturePattern(text, [
      /history[:\s]+(.*?)(?:\s+\d+\.\s+[A-Z]|$)/i,
    ]);
  }

  const yearFoundedMatch = text.match(/\b(?:founded|established|incorporated)\s+(?:in\s+)?(19|20)\d{2}\b/i);
  if (yearFoundedMatch) {
    profile.year_founded = yearFoundedMatch[0].match(/(19|20)\d{2}/)?.[0] || '';
  }

  if (profile.email && (!profile.first_name || !profile.last_name || !profile.contact_name)) {
    const inferredName = inferNameFromEmail(profile.email);
    if (!profile.first_name && inferredName.first) {
      profile.first_name = inferredName.first;
    }
    if (!profile.last_name && inferredName.last) {
      profile.last_name = inferredName.last;
    }
    if (!profile.contact_name && inferredName.full) {
      profile.contact_name = inferredName.full;
    }
  }

  return profile;
}

async function generateAutofillAnswersBatch(options: {
  organizationContext: string;
  grantContext: string;
  pageTitle: string;
  pageUrl: string;
  fields: Array<{
    index: number;
    fieldKey: string;
    questionText: string;
    descriptor: string;
    tagName: string;
    inputType: string;
  }>;
}): Promise<Array<{
  index: number;
  fieldKey: string;
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  rationale: string;
}>> {
  const instructions = `${RAG_SYSTEM_INSTRUCTION}

You are generating auto-fill values for a set of grant portal fields.
Return strict JSON only in this shape:
{
  "answers": [
    {
      "index": number,
      "fieldKey": string,
      "answer": string,
      "confidence": "high" | "medium" | "low",
      "rationale": string
    }
  ]
}

Rules:
- Preserve the input index exactly.
- Only answer fields when the organization context explicitly supports the response.
- For factual identity fields, do not guess.
- Do not invent a person's first name, last name, phone, EIN, UEI, DUNS, address, or email.
- Treat contact, email, phone, website, address, city, state, zip, country, EIN, UEI, DUNS, and job title as factual fields.
- You may synthesize wording only for narrative-style fields and project_title.
- For project_title, if the mission/program context is clear but no exact title exists, you may create a short, truthful title grounded in the described work.
- For narrative and organization-description fields, write a concise grant-ready answer in one paragraph.
- For narrative and organization-description fields, write polished grant-ready prose in full sentences.
- When a field asks who is served and how the organization identifies or reaches them, answer both parts explicitly.
- When a field asks about mission, history, and community need, answer all three parts explicitly.
- For short text fields, keep the answer short.
- If a field should be skipped, return answer as an empty string with low confidence.
- fieldKey must stay the same as provided unless it is blank, in which case return "unknown".
- If you are unsure, leave the answer blank.`;

  const fieldGuide = options.fields.map((field) => ({
    index: field.index,
    fieldKey: field.fieldKey,
    guidance: getFieldSpecificGuidance(field.fieldKey),
  }));

  const prompt = `Page title: ${options.pageTitle || 'n/a'}
Page URL: ${options.pageUrl || 'n/a'}

Grant context:
${options.grantContext || 'n/a'}

Organization profile context:
${options.organizationContext}

Field-specific guidance:
${JSON.stringify(fieldGuide, null, 2)}

Fields to answer:
${JSON.stringify(options.fields, null, 2)}`;

  const raw = await generateModelText(instructions, prompt);
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    const parsed = JSON.parse(cleaned) as {
      answers?: Array<{
        index?: number;
        fieldKey?: string;
        answer?: string;
        confidence?: 'high' | 'medium' | 'low';
        rationale?: string;
      }>;
    };

    return (parsed.answers || [])
      .filter((item) => typeof item.index === 'number')
      .map((item) => ({
        index: item.index as number,
        fieldKey: item.fieldKey?.trim() || 'unknown',
        answer: item.answer?.trim() || '',
        confidence: item.confidence === 'high' || item.confidence === 'medium' || item.confidence === 'low'
          ? item.confidence
          : 'low',
        rationale: item.rationale?.trim() || 'No rationale returned.',
      }));
  } catch {
    return [];
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

async function generateGeminiText(instructions: string, prompt: string): Promise<string> {
  if (!genAI) {
    throw new Error('Gemini client is not configured.');
  }

  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: instructions,
  });
  const result = await model.generateContent(prompt);
  return (result.response.text() ?? '').trim();
}

async function generateModelText(
  instructions: string,
  prompt: string,
  history: Array<{ role: 'user' | 'model'; content: string }> = []
): Promise<string> {
  if (OPENAI_API_KEY) {
    const messages = [
      ...history.map((message) => ({
        role: message.role === 'model' ? 'assistant' as const : 'user' as const,
        content: message.content,
      })),
      { role: 'user' as const, content: prompt },
    ];
    return await generateOpenAIText(instructions, messages);
  }

  return await generateGeminiText(instructions, prompt);
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

    const text = await generateModelText(
      buildSystemInstruction(profile, grantContext),
      toSend,
      priorHistory
    );

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

    const { organizationContext } = await resolveOrganizationContext(organizationProfile, userId);

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

app.post('/api/autofill-fields', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      fields = [],
      pageTitle = '',
      pageUrl = '',
      organizationProfile = '',
      grantContext = '',
      userId = '',
    } = req.body as AutofillFieldsRequestBody;

    if (!Array.isArray(fields) || fields.length === 0) {
      res.status(400).json({ error: 'fields is required and must be a non-empty array' });
      return;
    }

    const normalizedFields = (fields as AutofillFieldCandidate[])
      .map((field) => ({
        index: typeof field.index === 'number' ? field.index : Number(field.index),
        fieldKey: typeof field.fieldKey === 'string' ? field.fieldKey.trim() : '',
        questionText: typeof field.questionText === 'string' ? field.questionText.trim() : '',
        descriptor: typeof field.descriptor === 'string' ? field.descriptor.trim() : '',
        tagName: typeof field.tagName === 'string' ? field.tagName.trim() : '',
        inputType: typeof field.inputType === 'string' ? field.inputType.trim() : '',
      }))
      .filter((field) => Number.isFinite(field.index) && field.questionText);

    if (!normalizedFields.length) {
      res.status(400).json({ error: 'No valid fields were provided.' });
      return;
    }

    const { organizationContext, documentContextUsed } = await resolveOrganizationContext(organizationProfile, userId);

    if (!organizationContext) {
      res.status(400).json({ error: 'organizationProfile or user document context is required' });
      return;
    }

    const answers = await generateAutofillAnswersBatch({
      organizationContext,
      grantContext: typeof grantContext === 'string' ? grantContext.trim() : '',
      pageTitle: typeof pageTitle === 'string' ? pageTitle.trim() : '',
      pageUrl: typeof pageUrl === 'string' ? pageUrl.trim() : '',
      fields: normalizedFields,
    });

    res.json({
      answers,
      documentContextUsed,
    });
  } catch (err) {
    console.error('Autofill fields error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to generate autofill answers',
    });
  }
});

app.post('/api/profile-structure', async (req: Request, res: Response): Promise<void> => {
  try {
    const { organizationProfile = '', userId = '' } = req.body as ProfileStructuringRequestBody;
    const { organizationContext: context, documentContextUsed } = await resolveOrganizationContext(organizationProfile, userId);

    if (!context) {
      res.status(400).json({ error: 'organizationProfile or user document context is required' });
      return;
    }

    const profile = await structureOrganizationProfile(context);
    res.json({ profile, documentContextUsed });
  } catch (err) {
    console.error('Profile structure error:', err);
    res.status(500).json({
      error: err instanceof Error ? err.message : 'Failed to structure organization profile',
    });
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
