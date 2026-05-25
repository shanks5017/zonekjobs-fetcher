/**
 * Jobhive (ats-scrapers) → Supabase Integration Fetcher
 * 
 * Spawns the jobhive Python CLI to scrape jobs, resolves company logos,
 * and upserts the full enriched job payload into Supabase.
 *
 * Run modes:
 *   Full sync:        node --env-file=.env jobhive-fetcher/run.mjs
 *   Single company:   node --env-file=.env jobhive-fetcher/run.mjs --ats greenhouse --token postman --name Postman --website postman.com --country India
 */

import { existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execFile } from 'child_process'
import { promisify } from 'util'
import * as cheerio from 'cheerio'
import { upsertCompany, upsertJobs, cleanupMissingJobs, expireOldJobs, logRun } from '../shared/supabase.mjs'
import { parseExperience, inferExperienceLevel } from '../shared/experience.mjs'
import { parseSalary } from '../shared/salary.mjs'
import { getCompanyMetadata } from '../shared/enricher.mjs'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function cleanDescription(html) {
  if (!html) return null
  if (!html.includes('<')) return html.slice(0, 8000).trim()
  try {
    const $ = cheerio.load(html)
    return $.text().trim().replace(/\s+/g, ' ').slice(0, 8000)
  } catch (e) {
    return html.slice(0, 8000)
  }
}

// ─── RESOLVE JOBHIVE CLI BINARY ──────────────────────────────────────────────
// Searches for the locally installed virtual-env binary first,
// falls back to globally installed `jobhive` (used in GitHub Actions).
let _cachedBinary = null
function getJobhiveBinary() {
  if (_cachedBinary) return _cachedBinary
  const possiblePaths = [
    path.resolve(__dirname, '../../ats-scrapers/.venv/Scripts/jobhive.exe'),
    path.resolve(__dirname, '../../ats-scrapers/.venv/Scripts/jobhive'),
    path.resolve(__dirname, '../../ats-scrapers/.venv/bin/jobhive'),
    path.resolve(__dirname, '../ats-scrapers/.venv/Scripts/jobhive.exe'),
    path.resolve(__dirname, '../ats-scrapers/.venv/bin/jobhive'),
  ]
  for (const p of possiblePaths) {
    if (existsSync(p)) {
      console.log(`🔍 Jobhive binary: ${p}`)
      _cachedBinary = p
      return p
    }
  }
  console.warn('⚠️  No local venv found — using global "jobhive" (GitHub Actions mode)')
  _cachedBinary = 'jobhive'
  return 'jobhive'
}

// ─── EMPLOYMENT TYPE NORMALIZER ───────────────────────────────────────────────
function normalizeJobType(employment_type, title, commitment) {
  const et = (employment_type || '').toUpperCase()
  const t  = (title || '').toLowerCase()
  const c  = (commitment || '').toLowerCase()
  if (et === 'INTERN'    || t.includes('intern')    || c.includes('intern'))    return 'internship'
  if (et === 'PART_TIME' || t.includes('part-time') || t.includes('part time')) return 'parttime'
  if (et === 'CONTRACT'  || t.includes('contract')  || c.includes('contract'))  return 'contract'
  if (et === 'TEMPORARY' || t.includes('temporary'))                             return 'contract'
  return 'fulltime'
}

// ─── INDIA / REMOTE JOB FILTER ────────────────────────────────────────────────
// Returns true only for jobs that are:
//   • Located in India (city, state, or country match), OR
//   • Explicitly remote / worldwide / global
// This is applied per-job so we never store irrelevant listings.
const INDIA_SIGNALS  = ['india', 'bengaluru', 'bangalore', 'mumbai', 'delhi', 'hyderabad',
                        'pune', 'chennai', 'kolkata', 'noida', 'gurugram', 'gurgaon', 'in']
const REMOTE_SIGNALS = ['remote', 'worldwide', 'global', 'anywhere', 'work from home', 'wfh']

function isIndiaOrRemoteJob(job) {
  const loc     = (job.location    || '').toLowerCase()
  const country = (job.country     || '').toLowerCase()
  const title   = (job.title       || '').toLowerCase()
  const countryIso = (job.country_iso || '').toLowerCase()

  // Explicit remote flag set by jobhive
  if (job.is_remote === true) return true

  // Country ISO: India = 'in'
  if (countryIso === 'in') return true

  const haystack = `${loc} ${country} ${title}`

  if (INDIA_SIGNALS.some(s  => haystack.includes(s)))  return true
  if (REMOTE_SIGNALS.some(s => haystack.includes(s)))  return true

  return false
}

// ─── JOBHIVE SCRAPER HELPER ──────────────────────────────────────────────────
async function fetchJobhive(ats, token) {
  const binary = getJobhiveBinary()
  try {
    const { stdout } = await execFileAsync(
      binary,
      ['scrape', ats, token, '--format', 'json'],
      { maxBuffer: 30 * 1024 * 1024 } // 30 MB
    )

    const parsed = JSON.parse(stdout.trim())
    if (!Array.isArray(parsed)) return []

    const allJobs = parsed.map((job) => {
      const location    = job.location || null
      const titleLower  = (job.title || '').toLowerCase()
      const isRemote    = job.is_remote ?? (
        titleLower.includes('remote') ||
        (location || '').toLowerCase().includes('remote')
      )

      // Truncate description to 8 KB and strip HTML tags
      const description = cleanDescription(job.description)
      const parsedExp = parseExperience(job.title, job.description)
      const expLevel = inferExperienceLevel(job.title, job.description, parsedExp)
      const parsedSalary = parseSalary(job.title, job.description)

      const salaryMin = job.salary_min ?? parsedSalary.salary_min ?? null
      const salaryMax = job.salary_max ?? parsedSalary.salary_max ?? null
      const salaryCurrency = job.salary_currency ?? parsedSalary.salary_currency ?? null
      const salaryAvg = (salaryMin && salaryMax) ? Math.round((salaryMin + salaryMax) / 2) : null

      return {
        // ── Identity ────────────────────────────────────────────────────────
        external_id:      String(job.ats_id || job.global_id),
        ats_provider:     job.ats_type,
        apply_url:        String(job.apply_url || job.url || ''),

        // ── Core ────────────────────────────────────────────────────────────
        title:            job.title,
        description:      description,
        location:         location,
        country:          job.country_iso || null,
        is_remote:        isRemote,

        // ── Classification ──────────────────────────────────────────────────
        job_type:         normalizeJobType(job.employment_type, job.title, job.commitment),
        experience:       parsedExp,
        experience_level: expLevel,
        department:       job.department || null,

        // ── Compensation ────────────────────────────────────────────────────
        salary_min:       salaryMin,
        salary_max:       salaryMax,
        salary_currency:  salaryCurrency,
        salary_avg:       salaryAvg,

        // ── Timing ──────────────────────────────────────────────────────────
        posted_at:        job.posted_at
          ? new Date(job.posted_at).toISOString()
          : null,
        fetched_at:       new Date().toISOString(),

        // ── Meta ────────────────────────────────────────────────────────────
        is_active:        true,
        source_repo:      'jobhive',
      }
    })

    // ── India / Remote filter ──────────────────────────────────────────────
    // For India-based companies every job they post is relevant.
    // For global companies we only keep jobs tagged India or Remote.
    const filtered = allJobs.filter(j => isIndiaOrRemoteJob(j))
    console.log(`    🔍 ${allJobs.length} raw → ${filtered.length} India/Remote kept`)
    return filtered
  } catch (err) {
    // Surface the jobhive error message cleanly (board not found, etc.)
    const msg = err.stderr?.trim() || err.message
    console.error(`  ✗ Scrape failed [${ats}:${token}]: ${msg.split('\n')[0]}`)
    return []
  }
}

// ─── CURATED COMPANY LIST ────────────────────────────────────────────────────
// All tokens verified to return live jobs via `jobhive list-ats` + manual checks.
// Workday tokens = full URL (jobhive WorkdayScraper parses subdomain + path).
// Tesla on Jobhive is its own scraper (ATSType.TESLA), not Greenhouse.

// ─── CURATED COMPANY LIST ────────────────────────────────────────────────────
// Only India-headquartered companies + remote-first global companies that
// regularly post India or Remote roles.
// The isIndiaOrRemoteJob() filter applied at fetch time is the final gate —
// even global companies here only contribute India/Remote listings.

const CURATED_COMPANIES = [

  // ── India-headquartered — Greenhouse ──────────────────────────────────────
  { name: 'Razorpay',        website: 'razorpay.com',     atsProvider: 'greenhouse', atsToken: 'razorpaysoftwareprivatelimited', country: 'India', industry: 'Fintech' },
  { name: 'Postman',         website: 'postman.com',      atsProvider: 'greenhouse', atsToken: 'postman',        country: 'India', industry: 'Developer Tools' },
  { name: 'Groww',           website: 'groww.in',         atsProvider: 'greenhouse', atsToken: 'groww',          country: 'India', industry: 'Fintech' },
  { name: 'PhonePe',         website: 'phonepe.com',      atsProvider: 'greenhouse', atsToken: 'phonepe',        country: 'India', industry: 'Fintech' },
  { name: 'Slice',           website: 'sliceit.com',      atsProvider: 'greenhouse', atsToken: 'slice',          country: 'India', industry: 'Fintech' },
  { name: 'InMobi',          website: 'inmobi.com',       atsProvider: 'greenhouse', atsToken: 'inmobi',         country: 'India', industry: 'AdTech' },

  // ── India-headquartered — Lever ───────────────────────────────────────────
  { name: 'Meesho',          website: 'meesho.com',       atsProvider: 'lever',      atsToken: 'meesho',         country: 'India', industry: 'E-Commerce' },
  { name: 'CRED',            website: 'cred.club',        atsProvider: 'lever',      atsToken: 'cred',           country: 'India', industry: 'Fintech' },

  // ── India-headquartered — Ashby ───────────────────────────────────────────
  { name: 'Volopay',         website: 'volopay.com',      atsProvider: 'ashby',      atsToken: 'volopay',        country: 'India', industry: 'Fintech' },

  // ── India-headquartered — SmartRecruiters ─────────────────────────────────
  { name: 'Freshworks',      website: 'freshworks.com',   atsProvider: 'smartrecruiters', atsToken: 'Freshworks',  country: 'India', industry: 'SaaS' },
  { name: 'Unacademy',       website: 'unacademy.com',    atsProvider: 'smartrecruiters', atsToken: 'Unacademy',   country: 'India', industry: 'EdTech' },

  // ── India-headquartered — Workday ─────────────────────────────────────────
  { name: 'Swiggy',          website: 'swiggy.com',       atsProvider: 'workday',    atsToken: 'https://swiggy.wd3.myworkdayjobs.com/Swiggy',           country: 'India', industry: 'Food Delivery' },
  { name: 'Infosys',         website: 'infosys.com',      atsProvider: 'workday',    atsToken: 'https://infosys.wd3.myworkdayjobs.com/Infosys_Careers',  country: 'India', industry: 'IT Services' },
  { name: 'Wipro',           website: 'wipro.com',        atsProvider: 'workday',    atsToken: 'https://wipro.wd3.myworkdayjobs.com/External',           country: 'India', industry: 'IT Services' },

  // ── Remote-first global companies (kept because they actively hire remotely
  //    or have strong India offices — isIndiaOrRemoteJob() filters per listing)
  { name: 'Anthropic',       website: 'anthropic.com',    atsProvider: 'greenhouse', atsToken: 'anthropic',      country: 'United States', industry: 'AI' },
  { name: 'Cloudflare',      website: 'cloudflare.com',   atsProvider: 'greenhouse', atsToken: 'cloudflare',     country: 'United States', industry: 'Cloud' },
  { name: 'Datadog',         website: 'datadoghq.com',    atsProvider: 'greenhouse', atsToken: 'datadog',        country: 'United States', industry: 'DevOps' },
  { name: 'Notion',          website: 'notion.so',        atsProvider: 'greenhouse', atsToken: 'notion',         country: 'United States', industry: 'Productivity' },
  { name: 'Stripe',          website: 'stripe.com',       atsProvider: 'greenhouse', atsToken: 'stripe',         country: 'United States', industry: 'Fintech' },
  { name: 'Scale AI',        website: 'scale.com',        atsProvider: 'lever',      atsToken: 'scaleai',        country: 'United States', industry: 'AI' },
  { name: 'Coinbase',        website: 'coinbase.com',     atsProvider: 'lever',      atsToken: 'coinbase',       country: 'United States', industry: 'Crypto' },
  { name: 'OpenAI',          website: 'openai.com',       atsProvider: 'ashby',      atsToken: 'openai',         country: 'United States', industry: 'AI' },
  { name: 'Vercel',          website: 'vercel.com',       atsProvider: 'ashby',      atsToken: 'vercel',         country: 'United States', industry: 'Cloud' },
  { name: 'Hugging Face',    website: 'huggingface.co',   atsProvider: 'ashby',      atsToken: 'huggingface',    country: 'United States', industry: 'AI' },
  { name: 'ElevenLabs',      website: 'elevenlabs.io',    atsProvider: 'ashby',      atsToken: 'elevenlabs',     country: 'United States', industry: 'AI' },
  { name: 'Perplexity',      website: 'perplexity.ai',    atsProvider: 'ashby',      atsToken: 'perplexityai',   country: 'United States', industry: 'AI' },
  { name: 'Mistral AI',      website: 'mistral.ai',       atsProvider: 'ashby',      atsToken: 'mistral',        country: 'France',        industry: 'AI' },

  // ── Global with large India offices (job-level filter still applies) ───────
  { name: 'Deloitte',        website: 'deloitte.com',     atsProvider: 'workday',    atsToken: 'https://deloitte.wd2.myworkdayjobs.com/Deloitte_External_Careers', country: 'United States', industry: 'Consulting' },
  { name: 'Goldman Sachs',   website: 'goldmansachs.com', atsProvider: 'workday',    atsToken: 'https://gs.wd1.myworkdayjobs.com/External_Career_Site',           country: 'United States', industry: 'Finance' },
  { name: 'Capgemini',       website: 'capgemini.com',    atsProvider: 'smartrecruiters', atsToken: 'capgemini', country: 'France', industry: 'IT Services' },
]

// ─── MAIN RUNNER ──────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2)
  let targetList = CURATED_COMPANIES

  const atsIndex     = args.indexOf('--ats')
  const tokenIndex   = args.indexOf('--token')
  const nameIndex    = args.indexOf('--name')
  const websiteIndex = args.indexOf('--website')
  const countryIndex = args.indexOf('--country')

  if (atsIndex !== -1 && tokenIndex !== -1) {
    const ats     = args[atsIndex + 1]
    const token   = args[tokenIndex + 1]
    const name    = nameIndex    !== -1 ? args[nameIndex + 1]    : token
    const website = websiteIndex !== -1 ? args[websiteIndex + 1] : null
    const country = countryIndex !== -1 ? args[countryIndex + 1] : 'Global'

    console.log(`🎯 Single-company mode: ${name} (${ats}:${token})`)
    targetList = [{ name, atsProvider: ats, atsToken: token, website, country }]
  }

  console.log('🚀 Jobhive → Supabase sync starting...')
  console.log(`📋 Processing ${targetList.length} companies\n`)

  // Warm up binary lookup once
  getJobhiveBinary()

  let totalJobs = 0
  let skipped   = 0

  for (const company of targetList) {
    console.log(`💼 ${company.name} [${company.atsProvider}:${company.atsToken?.slice(0, 40)}]`)
    try {
      const jobs = await fetchJobhive(company.atsProvider, company.atsToken)

      const slug = company.name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')

      if (!jobs.length) {
        console.log(`  ⚠  No jobs — skipping company creation`)
        skipped++
        continue
      }

      console.log(`  🔍 Fetching logo/website for ${company.name}...`)
      const enrichedMeta = await getCompanyMetadata(company.name, company.atsProvider, company.atsToken)

      const companyPayload = {
        name:        company.name,
        slug,
        website:     enrichedMeta?.website || company.website || null,
        logo_url:    enrichedMeta?.logo_url || null,
        industry:    company.industry || null,
        country:     company.country || 'Global',
        atsProvider: company.atsProvider,
        atsToken:    company.atsToken,
        atsUrl:      company.website ? `https://${company.website}` : null,
        source:      'jobhive',
      }

      const companyId = await upsertCompany(companyPayload)
      if (!companyId) { skipped++; continue }

      const jobsWithCompany = jobs.map((j) => ({ ...j, company_id: companyId }))
      const count = await upsertJobs(jobsWithCompany)
      totalJobs += count
      console.log(`  ✓ ${count} jobs upserted`)

      // Cleanup stale jobs (local diff → batch delete)
      const currentIds = jobs.map(j => j.external_id)
      await cleanupMissingJobs(companyId, currentIds)

      // Throttle: 500 ms between companies to avoid overwhelming ATS APIs
      await new Promise((r) => setTimeout(r, 500))
    } catch (err) {
      console.error(`  ✗ Unexpected error: ${err.message}`)
      skipped++
    }
  }

  await expireOldJobs(30)
  await logRun('jobhive', totalJobs, 'success')
  console.log(`\n✅ Done! ${totalJobs} jobs synced | ${skipped} companies skipped/empty`)
}

main().catch((err) => {
  console.error('Fatal execution error:', err)
  process.exit(1)
})
