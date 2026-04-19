#!/usr/bin/env node
/**
 * URL checker for grants-seed.json
 * Tests each grant URL and reports broken/redirected ones
 */

import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedPath = path.resolve(__dirname, 'src', 'data', 'grants-seed.json');
const { grants } = JSON.parse(readFileSync(seedPath, 'utf8'));

const CONCURRENCY = 5;
const TIMEOUT_MS = 10000;

async function checkUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; grant-checker/1.0)' },
    });
    clearTimeout(timer);
    return { status: res.status, ok: res.status < 400, finalUrl: res.url };
  } catch (err) {
    clearTimeout(timer);
    return { status: 0, ok: false, error: err.name === 'AbortError' ? 'TIMEOUT' : err.message };
  }
}

async function runInBatches(items, batchSize, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    process.stdout.write(`\r  Checked ${Math.min(i + batchSize, items.length)}/${items.length}...`);
  }
  console.log();
  return results;
}

async function main() {
  console.log(`\nChecking ${grants.length} grant URLs (concurrency: ${CONCURRENCY}, timeout: ${TIMEOUT_MS / 1000}s)...\n`);

  const results = await runInBatches(grants, CONCURRENCY, async (g) => {
    const result = await checkUrl(g.application_url);
    return { id: g.id, title: g.opportunity_title, url: g.application_url, ...result };
  });

  const ok = results.filter(r => r.ok);
  const broken = results.filter(r => !r.ok);

  console.log(`\n✓ Working: ${ok.length}`);
  console.log(`✗ Broken/Unreachable: ${broken.length}\n`);

  if (broken.length > 0) {
    console.log('BROKEN URLs:');
    broken.forEach(r => {
      console.log(`  [${r.status || r.error}] ${r.title}`);
      console.log(`         ${r.url}`);
    });
  }

  // Save full report
  const reportPath = path.resolve(__dirname, 'url-check-report.json');
  writeFileSync(reportPath, JSON.stringify({ checked_at: new Date().toISOString(), ok: ok.length, broken: broken.length, results }, null, 2));
  console.log(`\nFull report saved to url-check-report.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
