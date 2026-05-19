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
import { upsertCompany, upsertJobs, cleanupMissingJobs, expireOldJobs, logRun } from '../shared/supabase.mjs'

const execFileAsync = promisify(execFile)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

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

// ─── EXPERIENCE LEVEL INFERRER ────────────────────────────────────────────────
function inferExperienceLevel(title, description) {
  const text = ((title || '') + ' ' + (description || '')).toLowerCase()
  if (text.includes('vp ') || text.includes('vice president') || text.includes('director') || text.includes('chief')) return 'executive'
  if (text.includes('senior') || text.includes('staff ') || text.includes('principal') || text.includes('lead ')) return 'senior'
  if (text.includes('junior') || text.includes('entry') || text.includes('associate') || text.includes('intern')) return 'entry'
  if (text.includes('manager') || text.includes('mid-level') || text.includes('mid level')) return 'mid'
  return null
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

    return parsed.map((job) => {
      const location    = job.location || null
      const titleLower  = (job.title || '').toLowerCase()
      const isRemote    = job.is_remote ?? (
        titleLower.includes('remote') ||
        (location || '').toLowerCase().includes('remote')
      )

      // Truncate description to 8 KB — keeps Supabase row sizes sane
      const description = job.description
        ? job.description.slice(0, 8000)
        : null

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
        experience_level: inferExperienceLevel(job.title, job.description),
        department:       job.department || null,

        // ── Compensation ────────────────────────────────────────────────────
        salary_min:       job.salary_min      ?? null,
        salary_max:       job.salary_max      ?? null,
        salary_currency:  job.salary_currency ?? null,

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

const CURATED_COMPANIES = [

  // ── Greenhouse ─────────────────────────────────────────────────────────────
  { name: 'Razorpay',        website: 'razorpay.com',     atsProvider: 'greenhouse', atsToken: 'razorpaysoftwareprivatelimited', country: 'India',          industry: 'Fintech' },
  { name: 'Postman',         website: 'postman.com',      atsProvider: 'greenhouse', atsToken: 'postman',        country: 'India',          industry: 'Developer Tools' },
  { name: 'Groww',           website: 'groww.in',         atsProvider: 'greenhouse', atsToken: 'groww',          country: 'India',          industry: 'Fintech' },
  { name: 'PhonePe',         website: 'phonepe.com',      atsProvider: 'greenhouse', atsToken: 'phonepe',        country: 'India',          industry: 'Fintech' },
  { name: 'Slice',           website: 'sliceit.com',      atsProvider: 'greenhouse', atsToken: 'slice',          country: 'India',          industry: 'Fintech' },
  { name: 'InMobi',          website: 'inmobi.com',       atsProvider: 'greenhouse', atsToken: 'inmobi',         country: 'India',          industry: 'AdTech' },
  { name: 'Anthropic',       website: 'anthropic.com',    atsProvider: 'greenhouse', atsToken: 'anthropic',      country: 'United States',  industry: 'AI' },
  { name: 'Stripe',          website: 'stripe.com',       atsProvider: 'greenhouse', atsToken: 'stripe',         country: 'United States',  industry: 'Fintech' },
  { name: 'Figma',           website: 'figma.com',        atsProvider: 'greenhouse', atsToken: 'figma',          country: 'United States',  industry: 'Design' },
  { name: 'Cloudflare',      website: 'cloudflare.com',   atsProvider: 'greenhouse', atsToken: 'cloudflare',     country: 'United States',  industry: 'Cloud' },
  { name: 'Datadog',         website: 'datadoghq.com',    atsProvider: 'greenhouse', atsToken: 'datadog',        country: 'United States',  industry: 'DevOps' },
  { name: 'HashiCorp',       website: 'hashicorp.com',    atsProvider: 'greenhouse', atsToken: 'hashicorp',      country: 'United States',  industry: 'Cloud' },
  { name: 'Notion',          website: 'notion.so',        atsProvider: 'greenhouse', atsToken: 'notion',         country: 'United States',  industry: 'Productivity' },
  { name: 'Linear',          website: 'linear.app',       atsProvider: 'greenhouse', atsToken: 'linear',         country: 'United States',  industry: 'Developer Tools' },
  { name: 'Pagerduty',       website: 'pagerduty.com',    atsProvider: 'greenhouse', atsToken: 'pagerduty',      country: 'United States',  industry: 'DevOps' },
  { name: 'Checkr',          website: 'checkr.com',       atsProvider: 'greenhouse', atsToken: 'checkr',         country: 'United States',  industry: 'HR Tech' },

  // ── Lever ──────────────────────────────────────────────────────────────────
  { name: 'Meesho',          website: 'meesho.com',       atsProvider: 'lever',      atsToken: 'meesho',         country: 'India',          industry: 'E-Commerce' },
  { name: 'CRED',            website: 'cred.club',        atsProvider: 'lever',      atsToken: 'cred',           country: 'India',          industry: 'Fintech' },
  { name: 'Coinbase',        website: 'coinbase.com',     atsProvider: 'lever',      atsToken: 'coinbase',       country: 'United States',  industry: 'Crypto' },
  { name: 'Scale AI',        website: 'scale.com',        atsProvider: 'lever',      atsToken: 'scaleai',        country: 'United States',  industry: 'AI' },
  { name: 'Airtable',        website: 'airtable.com',     atsProvider: 'lever',      atsToken: 'airtable',       country: 'United States',  industry: 'Productivity' },
  { name: 'Intercom',        website: 'intercom.com',     atsProvider: 'lever',      atsToken: 'intercom',       country: 'United States',  industry: 'SaaS' },

  // ── Ashby ──────────────────────────────────────────────────────────────────
  { name: 'Volopay',         website: 'volopay.com',      atsProvider: 'ashby',      atsToken: 'volopay',        country: 'India',          industry: 'Fintech' },
  { name: 'OpenAI',          website: 'openai.com',       atsProvider: 'ashby',      atsToken: 'openai',         country: 'United States',  industry: 'AI' },
  { name: 'Perplexity',      website: 'perplexity.ai',    atsProvider: 'ashby',      atsToken: 'perplexityai',   country: 'United States',  industry: 'AI' },
  { name: 'Mistral AI',      website: 'mistral.ai',       atsProvider: 'ashby',      atsToken: 'mistral',        country: 'France',         industry: 'AI' },
  { name: 'Vercel',          website: 'vercel.com',       atsProvider: 'ashby',      atsToken: 'vercel',         country: 'United States',  industry: 'Cloud' },
  { name: 'Planetscale',     website: 'planetscale.com',  atsProvider: 'ashby',      atsToken: 'planetscale',    country: 'United States',  industry: 'Database' },
  { name: 'Cursor',          website: 'cursor.com',       atsProvider: 'ashby',      atsToken: 'anysphere',      country: 'United States',  industry: 'AI' },
  { name: 'ElevenLabs',      website: 'elevenlabs.io',    atsProvider: 'ashby',      atsToken: 'elevenlabs',     country: 'United States',  industry: 'AI' },
  { name: 'Hugging Face',    website: 'huggingface.co',   atsProvider: 'ashby',      atsToken: 'huggingface',    country: 'United States',  industry: 'AI' },

  // ── SmartRecruiters ────────────────────────────────────────────────────────
  { name: 'Freshworks',      website: 'freshworks.com',   atsProvider: 'smartrecruiters', atsToken: 'Freshworks',  country: 'India',         industry: 'SaaS' },
  { name: 'Unacademy',       website: 'unacademy.com',    atsProvider: 'smartrecruiters', atsToken: 'Unacademy',   country: 'India',         industry: 'EdTech' },
  { name: 'Capgemini',       website: 'capgemini.com',    atsProvider: 'smartrecruiters', atsToken: 'capgemini',   country: 'France',        industry: 'IT Services' },
  { name: 'IKEA',            website: 'ikea.com',         atsProvider: 'smartrecruiters', atsToken: 'IKEA',        country: 'Sweden',        industry: 'Retail' },

  // ── Workday ─────────────────────────────────────────────────────────────────
  // Token = full myworkdayjobs.com URL. Jobhive's WorkdayScraper parses the subdomain.
  { name: 'Walmart',         website: 'walmart.com',      atsProvider: 'workday',    atsToken: 'https://walmart.wd5.myworkdayjobs.com/en-US/Walmart_External_Careers',    country: 'United States',  industry: 'Retail' },
  { name: 'Deloitte',        website: 'deloitte.com',     atsProvider: 'workday',    atsToken: 'https://deloitte.wd2.myworkdayjobs.com/Deloitte_External_Careers',        country: 'United States',  industry: 'Consulting' },
  { name: 'Unilever',        website: 'unilever.com',     atsProvider: 'workday',    atsToken: 'https://unilever.wd5.myworkdayjobs.com/Unilever_External_Careers',        country: 'United Kingdom', industry: 'Consumer Goods' },
  { name: 'Goldman Sachs',   website: 'goldmansachs.com', atsProvider: 'workday',    atsToken: 'https://gs.wd1.myworkdayjobs.com/External_Career_Site',                  country: 'United States',  industry: 'Finance' },
  { name: 'Target',          website: 'target.com',       atsProvider: 'workday',    atsToken: 'https://target.wd5.myworkdayjobs.com/External_Careers',                  country: 'United States',  industry: 'Retail' },
  { name: 'Boeing',          website: 'boeing.com',       atsProvider: 'workday',    atsToken: 'https://boeing.wd1.myworkdayjobs.com/external',                          country: 'United States',  industry: 'Aerospace' },
  { name: 'Swiggy',          website: 'swiggy.com',       atsProvider: 'workday',    atsToken: 'https://swiggy.wd3.myworkdayjobs.com/Swiggy',                            country: 'India',          industry: 'Food Delivery' },
  { name: 'Infosys',         website: 'infosys.com',      atsProvider: 'workday',    atsToken: 'https://infosys.wd3.myworkdayjobs.com/Infosys_Careers',                  country: 'India',          industry: 'IT Services' },
  { name: 'Wipro',           website: 'wipro.com',        atsProvider: 'workday',    atsToken: 'https://wipro.wd3.myworkdayjobs.com/External',                           country: 'India',          industry: 'IT Services' },

  // ── SAP SuccessFactors ────────────────────────────────────────────────────
  { name: 'Samsung',         website: 'samsung.com',      atsProvider: 'successfactors', atsToken: 'samsung',    country: 'South Korea',    industry: 'Electronics' },
  { name: 'Siemens',         website: 'siemens.com',      atsProvider: 'successfactors', atsToken: 'siemens',    country: 'Germany',        industry: 'Engineering' },
  { name: 'Nestlé',          website: 'nestle.com',       atsProvider: 'successfactors', atsToken: 'nestle',     country: 'Switzerland',    industry: 'Consumer Goods' },
  { name: 'Volkswagen',      website: 'volkswagen.com',   atsProvider: 'successfactors', atsToken: 'volkswagenag', country: 'Germany',      industry: 'Automotive' },

  // ── Tesla (Jobhive has a dedicated TeslaScraper) ──────────────────────────
  { name: 'Tesla',           website: 'tesla.com',        atsProvider: 'tesla',      atsToken: 'tesla',          country: 'United States',  industry: 'Automotive / EV' },

  // ── Amazon (dedicated AmazonScraper) ─────────────────────────────────────
  { name: 'Amazon',          website: 'amazon.com',       atsProvider: 'amazon',     atsToken: 'amazon',         country: 'United States',  industry: 'E-Commerce / Cloud' },
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

      const companyPayload = {
        name:        company.name,
        slug,
        website:     company.website || null,
        industry:    company.industry || null,
        country:     company.country || 'Global',
        atsProvider: company.atsProvider,
        atsToken:    company.atsToken,
        atsUrl:      company.website ? `https://${company.website}` : null,
        source:      'jobhive',
      }

      if (!jobs.length) {
        console.log(`  ⚠  No jobs — upserting company record only`)
        skipped++
        const companyId = await upsertCompany(companyPayload)
        if (companyId) await cleanupMissingJobs(companyId, [])
        continue
      }

      // Logo is resolved inside upsertCompany via Clearbit
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
