#!/usr/bin/env node
/**
 * Uses GPT-4o to find corrected URLs for broken grant entries,
 * then patches grants-seed.json in place.
 */

import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) { console.error('Missing OPENAI_API_KEY'); process.exit(1); }

const seedPath = path.resolve(__dirname, 'src', 'data', 'grants-seed.json');
const reportPath = path.resolve(__dirname, 'url-check-report.json');

const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
const report = JSON.parse(readFileSync(reportPath, 'utf8'));

const brokenIds = new Set(report.results.filter(r => !r.ok).map(r => r.id));
const brokenGrants = seed.grants.filter(g => brokenIds.has(g.id));

console.log(`\nFixing ${brokenGrants.length} broken URLs using GPT-4o...\n`);

async function callGPT4o(prompt) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You are a grant research assistant. Given broken/outdated grant URLs, provide the best current official URL for each program. Return only valid JSON.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
      max_tokens: 2000,
    }),
  });
  if (!res.ok) throw new Error(`OpenAI error: ${res.status} ${await res.text()}`);
  return JSON.parse((await res.json()).choices[0].message.content);
}

async function main() {
  const prompt = `The following grant programs have broken/outdated URLs. For each, provide the best current official URL.

${brokenGrants.map(g => `ID: ${g.id}
Program: ${g.opportunity_title}
Provider: ${g.provider}
Old URL: ${g.application_url}`).join('\n\n')}

Return JSON as:
{
  "fixes": [
    { "id": "grant-id", "new_url": "https://correct-url.gov/..." },
    ...
  ]
}

Rules:
- Use the official homepage or program page for the provider if the specific page no longer exists
- Prefer .gov or official foundation domains
- If a program was discontinued, use the provider's main grants page
- Never return the same broken URL`;

  const result = await callGPT4o(prompt);
  const fixes = result.fixes ?? [];

  console.log(`GPT-4o returned ${fixes.length} fixes:\n`);

  // Apply fixes to seed
  const fixMap = Object.fromEntries(fixes.map(f => [f.id, f.new_url]));
  let patchCount = 0;

  seed.grants = seed.grants.map(g => {
    if (fixMap[g.id]) {
      console.log(`  ✓ ${g.opportunity_title}`);
      console.log(`    old: ${g.application_url}`);
      console.log(`    new: ${fixMap[g.id]}\n`);
      patchCount++;
      return { ...g, application_url: fixMap[g.id] };
    }
    return g;
  });

  seed.generated_at = new Date().toISOString();
  writeFileSync(seedPath, JSON.stringify(seed, null, 2));
  console.log(`\n✓ Patched ${patchCount} URLs in grants-seed.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
