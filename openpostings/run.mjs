/**
 * OpenPostings (Masterjx9) → Supabase
 * Runs on EVEN days via GitHub Actions.
 * Uses a curated list of Indian companies with known ATS tokens
 * (sourced from OpenPostings' 78k company database).
 * Focuses on companies NOT typically covered by OpenJobs.
 */

import { upsertCompany, upsertJobs, expireOldJobs, logRun } from '../shared/supabase.mjs'

// ─── ATS FETCH HELPERS ────────────────────────────────────────────────────────

async function fetchGreenhouse(token) {
  try {
    const res = await fetch(
      `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true`
    )
    if (!res.ok) return []
    const data = await res.json()
    return (data.jobs || []).map((job) => ({
      external_id: String(job.id),
      title: job.title,
      location: job.location?.name || 'India',
      is_remote: (job.location?.name || '').toLowerCase().includes('remote'),
      apply_url: job.absolute_url,
      ats_provider: 'greenhouse',
      job_type: 'fulltime',
      department: job.departments?.[0]?.name || null,
      posted_at: job.updated_at || new Date().toISOString(),
      fetched_at: new Date().toISOString(),
      is_active: true,
      source_repo: 'openpostings'
    }))
  } catch (err) {
    console.error(`  ✗ Greenhouse [${token}]:`, err.message)
    return []
  }
}

async function fetchLever(token) {
  try {
    const res = await fetch(
      `https://api.lever.co/v0/postings/${token}?mode=json`
    )
    if (!res.ok) return []
    const data = await res.json()
    return (data || []).map((job) => ({
      external_id: job.id,
      title: job.text,
      location: job.categories?.location || 'India',
      is_remote: (job.categories?.location || '').toLowerCase().includes('remote'),
      apply_url: job.hostedUrl,
      ats_provider: 'lever',
      job_type: (job.categories?.commitment || '')
        .toLowerCase()
        .includes('intern')
        ? 'internship'
        : 'fulltime',
      department: job.categories?.department || null,
      posted_at: job.createdAt
        ? new Date(job.createdAt).toISOString()
        : new Date().toISOString(),
      fetched_at: new Date().toISOString(),
      is_active: true,
      source_repo: 'openpostings'
    }))
  } catch (err) {
    console.error(`  ✗ Lever [${token}]:`, err.message)
    return []
  }
}

async function fetchAshby(token) {
  try {
    const res = await fetch(
      `https://api.ashbyhq.com/posting-api/job-board/${token}`
    )
    if (!res.ok) return []
    const data = await res.json()
    return (data.jobs || []).map((job) => ({
      external_id: job.id,
      title: job.title,
      location: job.location || 'India',
      is_remote: (job.location || '').toLowerCase().includes('remote'),
      apply_url: job.jobUrl,
      ats_provider: 'ashby',
      job_type: 'fulltime',
      department: job.department || null,
      posted_at: job.publishedDate || new Date().toISOString(),
      fetched_at: new Date().toISOString(),
      is_active: true,
      source_repo: 'openpostings'
    }))
  } catch (err) {
    console.error(`  ✗ Ashby [${token}]:`, err.message)
    return []
  }
}

async function fetchWorkday(subdomain) {
  try {
    const apiUrl = `https://${subdomain}.wd5.myworkdayjobs.com/wday/cxs/${subdomain}/External/jobs`
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 20, offset: 0 })
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.jobPostings || []).map((job) => ({
      external_id:
        job.bulletFields?.[0] || `${subdomain}-${job.title}`.replace(/\s+/g, '-'),
      title: job.title,
      location: job.locationsText || 'India',
      is_remote: false,
      apply_url: `https://${subdomain}.wd5.myworkdayjobs.com${job.externalPath}`,
      ats_provider: 'workday',
      job_type: 'fulltime',
      department: null,
      posted_at: new Date().toISOString(),
      fetched_at: new Date().toISOString(),
      is_active: true,
      source_repo: 'openpostings'
    }))
  } catch (err) {
    console.error(`  ✗ Workday [${subdomain}]:`, err.message)
    return []
  }
}

// ─── CURATED INDIAN COMPANY LIST (from OpenPostings 78k DB) ──────────────────
// These are verified working ATS tokens for Indian tech/startup companies.
// Add more entries here as you discover them from the OpenPostings DB.

const INDIAN_COMPANIES = [
  // ── Greenhouse ─────────────────────────────────────────────────────────────
  { name: 'Swiggy',          atsProvider: 'greenhouse', atsToken: 'swiggy' },
  { name: 'CRED',            atsProvider: 'greenhouse', atsToken: 'cred' },
  { name: 'Meesho',          atsProvider: 'greenhouse', atsToken: 'meesho' },
  { name: 'Razorpay',        atsProvider: 'greenhouse', atsToken: 'razorpay' },
  { name: 'BrowserStack',    atsProvider: 'greenhouse', atsToken: 'browserstack' },
  { name: 'Postman',         atsProvider: 'greenhouse', atsToken: 'postman' },
  { name: 'Freshworks',      atsProvider: 'greenhouse', atsToken: 'freshworks' },
  { name: 'Chargebee',       atsProvider: 'greenhouse', atsToken: 'chargebee' },
  { name: 'Hasura',          atsProvider: 'greenhouse', atsToken: 'hasura' },
  { name: 'Setu',            atsProvider: 'greenhouse', atsToken: 'setu' },
  { name: 'Darwinbox',       atsProvider: 'greenhouse', atsToken: 'darwinbox' },
  { name: 'Unacademy',       atsProvider: 'greenhouse', atsToken: 'unacademy' },
  { name: 'Groww',           atsProvider: 'greenhouse', atsToken: 'groww' },
  { name: 'Niyo',            atsProvider: 'greenhouse', atsToken: 'niyo' },
  { name: 'Slice',           atsProvider: 'greenhouse', atsToken: 'slice' },
  { name: 'Jupiter',         atsProvider: 'greenhouse', atsToken: 'jupiter' },
  { name: 'Setu',            atsProvider: 'greenhouse', atsToken: 'setu' },
  { name: 'Zetwerk',         atsProvider: 'greenhouse', atsToken: 'zetwerk' },
  { name: 'Innovaccer',      atsProvider: 'greenhouse', atsToken: 'innovaccer' },
  { name: 'Spinny',          atsProvider: 'greenhouse', atsToken: 'spinny' },

  // ── Lever ──────────────────────────────────────────────────────────────────
  { name: 'PhonePe',         atsProvider: 'lever', atsToken: 'phonepe' },
  { name: 'Nykaa',           atsProvider: 'lever', atsToken: 'nykaa' },
  { name: 'ShareChat',       atsProvider: 'lever', atsToken: 'sharechat' },
  { name: 'InMobi',          atsProvider: 'lever', atsToken: 'inmobi' },
  { name: 'Delhivery',       atsProvider: 'lever', atsToken: 'delhivery' },
  { name: 'Urban Company',   atsProvider: 'lever', atsToken: 'urbancompany' },
  { name: 'Vedantu',         atsProvider: 'lever', atsToken: 'vedantu' },
  { name: 'Zepto',           atsProvider: 'lever', atsToken: 'zepto' },
  { name: 'Licious',         atsProvider: 'lever', atsToken: 'licious' },
  { name: 'Mensa Brands',    atsProvider: 'lever', atsToken: 'mensabrands' },
  { name: 'Moglix',          atsProvider: 'lever', atsToken: 'moglix' },
  { name: 'Fareye',          atsProvider: 'lever', atsToken: 'fareye' },

  // ── Ashby ──────────────────────────────────────────────────────────────────
  { name: 'Spendflo',        atsProvider: 'ashby', atsToken: 'spendflo' },
  { name: 'Zluri',           atsProvider: 'ashby', atsToken: 'zluri' },
  { name: 'Multiplier',      atsProvider: 'ashby', atsToken: 'multiplier' },
  { name: 'Keka HR',         atsProvider: 'ashby', atsToken: 'keka' },
  { name: 'LeadSquared',     atsProvider: 'ashby', atsToken: 'leadsquared' },
  { name: 'Pepper Content',  atsProvider: 'ashby', atsToken: 'peppercontent' },
  { name: 'Plum',            atsProvider: 'ashby', atsToken: 'plumhq' },
  { name: 'Volopay',         atsProvider: 'ashby', atsToken: 'volopay' },
  { name: 'Recko',           atsProvider: 'ashby', atsToken: 'recko' },

  // ── Workday (subdomain only, not full URL) ─────────────────────────────────
  { name: 'Wipro',           atsProvider: 'workday', atsToken: 'wipro' },
  { name: 'HCL Technologies',atsProvider: 'workday', atsToken: 'hcl' },
  { name: 'Tech Mahindra',   atsProvider: 'workday', atsToken: 'techmahindra' },
  { name: 'Infosys',         atsProvider: 'workday', atsToken: 'infosys' },
  { name: 'Cognizant',       atsProvider: 'workday', atsToken: 'cognizant' },
]

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 OpenPostings → Supabase sync starting...')
  console.log(`Processing ${INDIAN_COMPANIES.length} curated Indian companies`)

  let totalJobs = 0

  for (const company of INDIAN_COMPANIES) {
    try {
      let jobs = []

      if (company.atsProvider === 'greenhouse') {
        jobs = await fetchGreenhouse(company.atsToken)
      } else if (company.atsProvider === 'lever') {
        jobs = await fetchLever(company.atsToken)
      } else if (company.atsProvider === 'ashby') {
        jobs = await fetchAshby(company.atsToken)
      } else if (company.atsProvider === 'workday') {
        jobs = await fetchWorkday(company.atsToken)
      }

      if (!jobs.length) {
        console.log(`  - ${company.name}: no jobs found`)
        continue
      }

      const slug = company.name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')

      const companyId = await upsertCompany({
        name: company.name,
        slug,
        website: company.website || null,
        industry: company.industry || null,
        country: 'India',
        atsProvider: company.atsProvider,
        atsToken: company.atsToken,
        atsUrl: company.atsUrl || null,
        source: 'openpostings'
      })

      if (!companyId) continue

      const jobsWithCompany = jobs.map((j) => ({ ...j, company_id: companyId }))
      const count = await upsertJobs(jobsWithCompany)
      totalJobs += count

      console.log(`  ✓ ${company.name}: ${count} jobs`)

      // Rate limiting — 400ms between requests
      await new Promise((r) => setTimeout(r, 400))
    } catch (err) {
      console.error(`  ✗ ${company.name}:`, err.message)
    }
  }

  await expireOldJobs(30)
  await logRun('openpostings', totalJobs, 'success')
  console.log(`✅ Done! ${totalJobs} jobs synced from OpenPostings`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
