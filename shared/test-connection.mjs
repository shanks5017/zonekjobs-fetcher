/**
 * Quick Supabase connection test.
 * Run with: npm run test:connection
 * Checks:
 *   1. Env vars are present
 *   2. Can reach Supabase project
 *   3. 'companies' table exists
 *   4. 'jobs' table exists (and has the unique constraint)
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

// ── 1. Check env vars ────────────────────────────────────────────────────────
console.log('\n🔍 Checking environment variables...')

if (!SUPABASE_URL) {
  console.error('  ✗ SUPABASE_URL is missing from .env')
  process.exit(1)
}
if (!SUPABASE_SERVICE_KEY) {
  console.error('  ✗ SUPABASE_SERVICE_KEY is missing from .env')
  process.exit(1)
}

console.log(`  ✓ SUPABASE_URL        = ${SUPABASE_URL}`)
console.log(`  ✓ SUPABASE_SERVICE_KEY = ${SUPABASE_SERVICE_KEY.slice(0, 20)}...`)

// ── 2. Connect ───────────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

// ── 3. Check 'companies' table ───────────────────────────────────────────────
console.log('\n🔍 Checking companies table...')
const { data: companiesData, error: companiesError } = await supabase
  .from('companies')
  .select('id, name, slug')
  .limit(3)

if (companiesError) {
  console.error('  ✗ companies table error:', companiesError.message)
  console.error('\n  → You need to create the table. Run this SQL in Supabase SQL editor:\n')
  console.error(`
create table if not exists companies (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  slug         text unique not null,
  website      text,
  industry     text,
  country      text,
  ats_provider text,
  ats_token    text,
  ats_url      text,
  source       text,
  updated_at   timestamptz default now()
);
  `)
  process.exit(1)
}
console.log(`  ✓ companies table OK (${companiesData.length} rows sampled)`)

// ── 4. Check 'jobs' table ────────────────────────────────────────────────────
console.log('\n🔍 Checking jobs table...')
const { data: jobsData, error: jobsError } = await supabase
  .from('jobs')
  .select('id, title, ats_provider, external_id')
  .limit(3)

if (jobsError) {
  console.error('  ✗ jobs table error:', jobsError.message)
  console.error('\n  → You need to create the table. Run this SQL in Supabase SQL editor:\n')
  console.error(`
create table if not exists jobs (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid references companies(id),
  external_id      text not null,
  title            text not null,
  location         text,
  is_remote        boolean default false,
  apply_url        text not null,
  ats_provider     text not null,
  job_type         text,
  department       text,
  experience       text,
  experience_level text,
  salary_min       integer,
  salary_max       integer,
  salary_currency  text,
  salary_avg       integer,
  posted_at        timestamptz,
  fetched_at       timestamptz default now(),
  is_active        boolean default true,
  source_repo      text,
  unique (external_id, ats_provider)
);
  `)
  process.exit(1)
}
console.log(`  ✓ jobs table OK (${jobsData.length} rows sampled)`)

// ── 5. Quick insert + dedup test ─────────────────────────────────────────────
console.log('\n🔍 Testing dedup upsert (external_id + ats_provider)...')
const testJob = {
  external_id:  '__test_connection_job__',
  title:        'Connection Test Job',
  location:     'Test Location',
  is_remote:    false,
  apply_url:    'https://example.com/jobs/test',
  ats_provider: '__test__',
  job_type:     'fulltime',
  fetched_at:   new Date().toISOString(),
  is_active:    false
}

const { error: insertError } = await supabase
  .from('jobs')
  .upsert(testJob, { onConflict: 'external_id,ats_provider', ignoreDuplicates: true })

if (insertError) {
  console.error('  ✗ Upsert test failed:', insertError.message)
  console.error('    → The unique constraint on (external_id, ats_provider) may be missing.')
  console.error('    → Run: ALTER TABLE jobs ADD CONSTRAINT jobs_external_id_ats_provider_key UNIQUE (external_id, ats_provider);')
  process.exit(1)
}

// Clean up test row
await supabase
  .from('jobs')
  .delete()
  .eq('external_id', '__test_connection_job__')
  .eq('ats_provider', '__test__')

console.log('  ✓ Dedup upsert works correctly')

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ✅ ALL CHECKS PASSED — Ready to run!

  Local:
    npm run fetch:openpostings
    npm run fetch:openjobs

  GitHub Actions:
    Push to GitHub and add secrets:
      SUPABASE_URL        = ${SUPABASE_URL}
      SUPABASE_SERVICE_KEY = <your service_role key>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`)
