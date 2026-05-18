/**
 * OpenPostings (Masterjx9) → Supabase
 * Runs on EVEN days via GitHub Actions.
 * Uses a curated list of Indian companies with known ATS tokens
 * (sourced from OpenPostings' 78k company database).
 * Focuses on companies NOT typically covered by OpenJobs.
 */

import { chromium } from 'playwright'
import { upsertCompany, upsertJobs, cleanupMissingJobs, expireOldJobs, logRun } from '../shared/supabase.mjs'

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

async function fetchWorkday(token, companyName) {
  try {
    // Some tokens might be full URLs, some just subdomains
    let subdomain = token
    let wd = 'wd5' // default

    if (token.includes('myworkdayjobs.com')) {
      const match = token.match(/https?:\/\/([^.]+)\.([^.]+)\.myworkdayjobs\.com/)
      if (match) {
        subdomain = match[1]
        wd = match[2]
      }
    }

    const apiUrl = `https://${subdomain}.${wd}.myworkdayjobs.com/wday/cxs/${subdomain}/External/jobs`
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
      apply_url: `https://${subdomain}.${wd}.myworkdayjobs.com${job.externalPath}`,
      ats_provider: 'workday',
      job_type: 'fulltime',
      department: null,
      posted_at: new Date().toISOString(),
      fetched_at: new Date().toISOString(),
      is_active: true,
      source_repo: 'openpostings'
    }))
  } catch (err) {
    console.error(`  ✗ Workday [${companyName || token}]:`, err.message)
    return []
  }
}

// ─── SMARTRECRUITERS FETCH HELPER ────────────────────────────────────────────
async function fetchSmartRecruiters(token) {
  try {
    let allJobs = []
    let offset = 0
    const limit = 100
    while (true) {
      const url = `https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=${limit}&offset=${offset}`
      const res = await fetch(url)
      if (!res.ok) break
      const data = await res.json()
      const batch = (data.content || [])
      allJobs = allJobs.concat(batch.map((job) => ({
        external_id: job.id,
        title: job.name,
        location: job.location?.city
          ? `${job.location.city}, ${job.location.country || 'India'}`
          : (job.location?.remote ? 'Remote' : 'India'),
        is_remote: job.location?.remote || false,
        apply_url: `https://careers.smartrecruiters.com/${token}/${job.id}`,
        ats_provider: 'smartrecruiters',
        job_type: job.typeOfEmployment?.id === 'PART_TIME' ? 'parttime' : 'fulltime',
        department: job.department?.label || null,
        posted_at: job.releasedDate || new Date().toISOString(),
        fetched_at: new Date().toISOString(),
        is_active: true,
        source_repo: 'openpostings'
      })))
      if (batch.length < limit) break
      offset += limit
    }
    return allJobs
  } catch (err) {
    console.error(`  ✗ SmartRecruiters [${token}]:`, err.message)
    return []
  }
}

// ─── PLAYWRIGHT WORKDAY FETCH (handles CSRF automatically) ────────────────────
async function fetchWorkdayPlaywright(subdomain, wd = 'wd5', jobBoardPath = 'External') {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    })
    const page = await context.newPage()

    // Set up response interception BEFORE navigating
    let jobsData = null
    page.on('response', async (response) => {
      if (response.url().includes('/jobs') && response.request().method() === 'POST') {
        try {
          const body = await response.json()
          if (body.jobPostings) jobsData = body
        } catch {}
      }
    })

    const baseUrl = `https://${subdomain}.${wd}.myworkdayjobs.com/${jobBoardPath}`
    await page.goto(baseUrl, { waitUntil: 'networkidle', timeout: 30000 })

    // Detect maintenance page
    const pageTitle = await page.title()
    if (pageTitle.toLowerCase().includes('unavailable') || pageTitle.toLowerCase().includes('maintenance')) {
      console.log(`  ⚠ Workday [${subdomain}]: system under maintenance, skipping`)
      return []
    }

    // Wait for jobs to load on page
    await page.waitForSelector('[data-automation-id="jobTitle"]', { timeout: 15000 }).catch(() => {})
    await new Promise(r => setTimeout(r, 2000))

    if (!jobsData) {
      // Try direct API call using CSRF token from cookies
      const cookies = await context.cookies()
      const csrfCookie = cookies.find(c => c.name.toLowerCase().includes('csrf') || c.name.toLowerCase().includes('xsrf'))
      const apiUrl = `https://${subdomain}.${wd}.myworkdayjobs.com/wday/cxs/${subdomain}/${jobBoardPath}/jobs`
      const headers = { 'Content-Type': 'application/json' }
      if (csrfCookie) headers['X-Calypso-CSRF-Token'] = csrfCookie.value

      try {
        const response = await page.evaluate(async ({ url, hdrs }) => {
          const res = await fetch(url, {
            method: 'POST',
            headers: hdrs,
            body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' })
          })
          return res.ok ? await res.json() : null
        }, { url: apiUrl, hdrs: headers })
        jobsData = response
      } catch (evalErr) {
        console.log(`  ⚠ Workday [${subdomain}]: page.evaluate failed — ${evalErr.message.split('\n')[0]}`)
      }
    }

    if (!jobsData?.jobPostings) return []

    return jobsData.jobPostings.map((job) => ({
      external_id: job.bulletFields?.[0] || `${subdomain}-${job.title}`.replace(/\s+/g, '-'),
      title: job.title,
      location: job.locationsText || 'India',
      is_remote: false,
      apply_url: `https://${subdomain}.${wd}.myworkdayjobs.com${job.externalPath}`,
      ats_provider: 'workday',
      job_type: 'fulltime',
      department: null,
      posted_at: new Date().toISOString(),
      fetched_at: new Date().toISOString(),
      is_active: true,
      source_repo: 'openpostings'
    }))

  } catch (err) {
    console.error(`  ✗ Workday Playwright [${subdomain}]:`, err.message)
    return []
  } finally {
    await browser.close()
  }
}

// ─── CURATED INDIAN COMPANY LIST ─────────────────────────────────────────────
// ✅ Verified working. Each entry lists ATS provider and token.
// 🎭 Playwright entries use browser automation — slower but reliable.

const INDIAN_COMPANIES = [
  // ── Greenhouse (verified ✓) ──────────────────────────────────────────────────
  { name: 'Razorpay',        website: 'razorpay.com', atsProvider: 'greenhouse',       atsToken: 'razorpaysoftwareprivatelimited' },
  { name: 'Postman',         website: 'postman.com', atsProvider: 'greenhouse',       atsToken: 'postman' },
  { name: 'Groww',           website: 'groww.in', atsProvider: 'greenhouse',       atsToken: 'groww' },
  { name: 'Slice',           website: 'sliceit.com', atsProvider: 'greenhouse',       atsToken: 'slice' },
  { name: 'PhonePe',         website: 'phonepe.com', atsProvider: 'greenhouse',       atsToken: 'phonepe' },
  { name: 'InMobi',          website: 'inmobi.com', atsProvider: 'greenhouse',       atsToken: 'inmobi' },

  // ── Lever (verified ✓) ──────────────────────────────────────────────────────
  { name: 'Meesho',          website: 'meesho.com', atsProvider: 'lever',            atsToken: 'meesho' },
  { name: 'CRED',            website: 'cred.club', atsProvider: 'lever',            atsToken: 'cred' },

  // ── Ashby (verified ✓) ──────────────────────────────────────────────────────
  { name: 'Volopay',         website: 'volopay.com', atsProvider: 'ashby',            atsToken: 'volopay' },

  // ── SmartRecruiters (verified ✓) ────────────────────────────────────────────
  { name: 'Freshworks',      website: 'freshworks.com', atsProvider: 'smartrecruiters',  atsToken: 'Freshworks' },
  { name: 'Unacademy',       website: 'unacademy.com', atsProvider: 'smartrecruiters',  atsToken: 'Unacademy' },

  // ── Workday via Playwright 🎭 (browser-automated) ────────────────────────────
  { name: 'Wipro',           website: 'wipro.com', atsProvider: 'workday-playwright', atsToken: 'wipro',         wd: 'wd5', jobBoard: 'External' },
  { name: 'HCL Technologies',website: 'hcltech.com', atsProvider: 'workday-playwright', atsToken: 'hcl',           wd: 'wd5', jobBoard: 'External' },
  { name: 'Tech Mahindra',   website: 'techmahindra.com', atsProvider: 'workday-playwright', atsToken: 'techmahindra',  wd: 'wd5', jobBoard: 'External' },
  { name: 'Infosys',         website: 'infosys.com', atsProvider: 'workday-playwright', atsToken: 'infosys',       wd: 'wd5', jobBoard: 'External' },
  { name: 'Cognizant',       website: 'cognizant.com', atsProvider: 'workday-playwright', atsToken: 'cognizant',     wd: 'wd5', jobBoard: 'External' },
  { name: 'Swiggy',          website: 'swiggy.com', atsProvider: 'workday-playwright', atsToken: 'swiggy',        wd: 'wd3', jobBoard: 'Swiggy' },
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
        jobs = await fetchWorkday(company.atsToken, company.name)
      } else if (company.atsProvider === 'smartrecruiters') {
        jobs = await fetchSmartRecruiters(company.atsToken)
      } else if (company.atsProvider === 'workday-playwright') {
        jobs = await fetchWorkdayPlaywright(company.atsToken, company.wd || 'wd5', company.jobBoard || 'External')
      }

      if (!jobs.length) {
        console.log(`  - ${company.name}: no jobs found`)
        
        // Rule 6: Cleanup Missing Jobs (Empty Company Rule)
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
        
        if (companyId) {
          await cleanupMissingJobs(companyId, [])
        }
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

      // Rule 6: Cleanup Missing Jobs (Stay Alive Rule)
      const currentIds = jobs.map(j => j.external_id)
      await cleanupMissingJobs(companyId, currentIds)

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
