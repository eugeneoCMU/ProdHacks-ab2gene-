#!/usr/bin/env node
/**
 * Grant Seed Generator
 * Uses GPT-4o to generate a diverse catalog of 50+ real grant programs
 * Output: src/data/grants-seed.json
 */

import { writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in .env');
  process.exit(1);
}

const CATEGORIES = [
  'Federal Government',
  'State & Local Government',
  'Private Foundation',
  'Corporate / CSR',
  'Health & Human Services',
  'Arts & Culture',
  'Technology & Innovation',
  'Environment & Conservation',
  'Education & Youth',
  'Community & Economic Development',
];

const SCHEMA_DESCRIPTION = `
Each grant object must have exactly these fields:
{
  "id": "unique-slug-string (kebab-case, no spaces)",
  "opportunity_title": "Full official grant name",
  "provider": "Organization or agency offering the grant",
  "category": "One of the 10 categories listed",
  "funding_min": <number in USD, or null if unknown>,
  "funding_max": <number in USD, or null if unknown>,
  "geographic_scope": "national" | "regional" | "state" | "local",
  "states_eligible": ["XX", "XX"] or [] for national,
  "eligibility_types": ["nonprofits_501c3", "state_governments", "local_governments", "individuals", "for_profit", "universities"] (array, pick all that apply),
  "focus_areas": ["area1", "area2"] (2-5 descriptive tags),
  "target_population": "Brief description of who is served",
  "description": "2-3 sentence description of the grant program and what it funds",
  "application_url": "Official URL (best guess at official program page)",
  "deadline_type": "rolling" | "annual" | "cycle" | "closed",
  "typical_deadline_month": <1-12 for annual/cycle, or null>,
  "is_recurring": true | false,
  "notes": "Any special requirements, matching funds, reporting, etc. (or empty string)"
}`;

async function callGPT4o(prompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are a nonprofit grants database expert with deep knowledge of federal, foundation, corporate, and state grant programs in the United States. You generate accurate, detailed grant catalog entries based on your training knowledge of real grant programs. Always return valid JSON only, no markdown, no extra text.`
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
      max_tokens: 6000,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenAI API error: ${response.status} ${text}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

async function generateBatch(category, index) {
  console.log(`  [${index + 1}/${CATEGORIES.length}] Generating: ${category}...`);

  const prompt = `Generate a JSON array of exactly 6 real grant programs for the category: "${category}".

Requirements:
- Use REAL, well-known grant programs that actually exist
- Spread across different states and regions — do NOT make everything national
- Include a mix of small ($5k-$50k), medium ($50k-$500k), and large ($500k+) grants
- For state grants, vary the states (CA, TX, NY, FL, IL, PA, OH, GA, WA, CO, etc.)
- Include diverse focus areas within this category
- For foundations use real ones: Gates, Kresge, MacArthur, Rockefeller, Annie E. Casey, Robert Wood Johnson, Walton, Ford, W.K. Kellogg, Knight, etc.
- For federal use real agencies: HHS, DOE, NEA, NEH, USDA, EPA, DOJ, HUD, HRSA, NIH, NSF, SBA, etc.
- For corporate use real programs: Google.org, Microsoft Philanthropies, JPMorgan Chase Foundation, Bank of America, Target Foundation, etc.

Schema for each grant:
${SCHEMA_DESCRIPTION}

Return JSON as: { "grants": [ ...exactly 6 grant objects... ] }`;

  const raw = await callGPT4o(prompt);
  const parsed = JSON.parse(raw);
  return (parsed.grants || []).map(g => ({ ...g, category }));
}

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Grant Seed Generator — GPT-4o');
  console.log('═══════════════════════════════════════════════════\n');

  // Load partial results if they exist (for resume after rate limit)
  let allGrants = [];
  const outDir0 = path.resolve(__dirname, 'src', 'data');
  const partialPath = path.resolve(outDir0, 'grants-seed.json');
  try {
    const { readFileSync } = await import('fs');
    const existing = JSON.parse(readFileSync(partialPath, 'utf8'));
    if (existing.grants?.length > 0) {
      allGrants = existing.grants;
      console.log(`  ↩ Resuming from partial save: ${allGrants.length} grants already stored\n`);
    }
  } catch {}

  const completedCategories = new Set(allGrants.map(g => g.category));

  for (let i = 0; i < CATEGORIES.length; i++) {
    if (completedCategories.has(CATEGORIES[i])) {
      console.log(`  [${i + 1}/${CATEGORIES.length}] Skipping (already done): ${CATEGORIES[i]}`);
      continue;
    }
    const grants = await generateBatch(CATEGORIES[i], i);
    allGrants.push(...grants);
    console.log(`    ✓ ${grants.length} grants added (total so far: ${allGrants.length})`);
    // Save incrementally after each batch
    const partialOutput = { generated_at: new Date().toISOString(), total: allGrants.length, grants: allGrants };
    const outDir2 = path.resolve(__dirname, 'src', 'data');
    mkdirSync(outDir2, { recursive: true });
    writeFileSync(path.resolve(outDir2, 'grants-seed.json'), JSON.stringify(partialOutput, null, 2));

    // Respect 3 RPM rate limit (1 request per 22s to be safe)
    if (i < CATEGORIES.length - 1) {
      process.stdout.write('    ⏱ Waiting 22s (rate limit)...');
      await new Promise(r => setTimeout(r, 22000));
      process.stdout.write(' done\n');
    }
  }

  // Deduplicate by id just in case
  const seen = new Set();
  const deduped = allGrants.filter(g => {
    if (seen.has(g.id)) return false;
    seen.add(g.id);
    return true;
  });

  // Add source metadata
  const output = {
    generated_at: new Date().toISOString(),
    total: deduped.length,
    categories: CATEGORIES,
    grants: deduped,
  };

  // Write to src/data/
  const outDir = path.resolve(__dirname, 'src', 'data');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.resolve(outDir, 'grants-seed.json');
  writeFileSync(outPath, JSON.stringify(output, null, 2));

  console.log(`\n  ✓ ${deduped.length} grants saved to src/data/grants-seed.json`);

  // Print category breakdown
  const breakdown = {};
  deduped.forEach(g => {
    breakdown[g.category] = (breakdown[g.category] || 0) + 1;
  });
  console.log('\n  Category breakdown:');
  Object.entries(breakdown).forEach(([cat, count]) => {
    console.log(`    ${cat}: ${count}`);
  });

  console.log('\n═══════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('Generation failed:', err);
  process.exit(1);
});
