/**
 * OpenJobs (outscal) → Supabase
 * Runs on ODD days via GitHub Actions.
 * Reads data/companies_v2.json from the cloned OpenJobs repo,
 * filters for India-relevant companies, fetches live jobs from
 * Greenhouse / Lever / Ashby / Workday, and upserts to Supabase.
 */

import { readFileSync } from 'fs'
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
      location: job.location?.name || 'Remote',
      is_remote: (job.location?.name || '').toLowerCase().includes('remote'),
      apply_url: job.absolute_url,
      ats_provider: 'greenhouse',
      job_type: 'fulltime',
      department: job.departments?.[0]?.name || null,
      posted_at: job.updated_at || new Date().toISOString(),
      fetched_at: new Date().toISOString(),
      is_active: true,
      source_repo: 'openjobs'
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
      location: job.categories?.location || 'Remote',
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
      source_repo: 'openjobs'
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
      location: job.location || 'Remote',
      is_remote: (job.location || '').toLowerCase().includes('remote'),
      apply_url: job.jobUrl,
      ats_provider: 'ashby',
      job_type: 'fulltime',
      department: job.department || null,
      posted_at: job.publishedDate || new Date().toISOString(),
      fetched_at: new Date().toISOString(),
      is_active: true,
      source_repo: 'openjobs'
    }))
  } catch (err) {
    console.error(`  ✗ Ashby [${token}]:`, err.message)
    return []
  }
}

async function fetchWorkday(atsUrl, companyName) {
  try {
    const match = atsUrl?.match(
      /https?:\/\/([^.]+)\.wd\d+\.myworkdayjobs\.com/
    )
    if (!match) return []

    const subdomain = match[1]
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
        job.bulletFields?.[0] || `${companyName}-${job.title}`.replace(/\s+/g, '-'),
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
      source_repo: 'openjobs'
    }))
  } catch (err) {
    console.error(`  ✗ Workday [${companyName}]:`, err.message)
    return []
  }
}

// ─── INDIA RELEVANCE FILTER ───────────────────────────────────────────────────

function isIndiaRelevant(company) {
  const countries = (company.countries || []).map((c) => c.toLowerCase())
  const name = (company.name || '').toLowerCase()

  return (
    countries.includes('india') ||
    countries.includes('in') ||
    countries.includes('remote') ||
    countries.includes('worldwide') ||
    countries.includes('global') ||
    name.includes('india')
  )
}

// ─── DETECT ATS PROVIDER FROM ats_links ───────────────────────────────────────

function detectProvider(atsLinks) {
  if (!atsLinks || typeof atsLinks !== 'object') return null
  const url = (Array.isArray(atsLinks) ? atsLinks[0] : Object.values(atsLinks)[0]) || ''

  if (url.includes('greenhouse.io')) return { provider: 'greenhouse', url }
  if (url.includes('lever.co'))      return { provider: 'lever', url }
  if (url.includes('ashbyhq.com'))   return { provider: 'ashby', url }
  if (url.includes('myworkdayjobs')) return { provider: 'workday', url }
  if (url.includes('smartrecruiters')) return { provider: 'smartrecruiters', url }
  if (url.includes('recruitee.com')) return { provider: 'recruitee', url }
  if (url.includes('bamboohr.com'))  return { provider: 'bamboohr', url }
  if (url.includes('breezy.hr'))     return { provider: 'breezy', url }
  return null
}

function extractToken(url, provider) {
  try {
    const u = new URL(url)
    if (provider === 'greenhouse') {
      // https://boards.greenhouse.io/companyslug → companyslug
      return u.pathname.split('/').filter(Boolean).pop()
    }
    if (provider === 'lever') {
      // https://jobs.lever.co/companyslug
      return u.pathname.split('/').filter(Boolean)[0]
    }
    if (provider === 'ashby') {
      // https://jobs.ashbyhq.com/companyslug
      return u.pathname.split('/').filter(Boolean)[0]
    }
    return u.pathname.split('/').filter(Boolean).pop()
  } catch {
    return null
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 OpenJobs → Supabase sync starting...')

  let companies = []
  try {
    const raw = readFileSync('./openjobs-repo/data/companies_v2.json', 'utf-8')
    companies = JSON.parse(raw)
  } catch (err) {
    console.error('✗ Failed to load companies_v2.json:', err.message)
    process.exit(1)
  }

  const targets = companies.filter(isIndiaRelevant)
  console.log(`Found ${targets.length} India-relevant companies out of ${companies.length} total`)

  let totalJobs = 0
  let processed = 0
  let skipped = 0

  for (const company of targets) {
    try {
      const atsInfo = detectProvider(company.ats_links)
      if (!atsInfo) {
        skipped++
        processed++
        continue
      }

      const { provider, url } = atsInfo
      const token = extractToken(url, provider)
      if (!token) {
        skipped++
        processed++
        continue
      }

      let jobs = []
      if (provider === 'greenhouse') jobs = await fetchGreenhouse(token)
      else if (provider === 'lever')  jobs = await fetchLever(token)
      else if (provider === 'ashby')  jobs = await fetchAshby(token)
      else if (provider === 'workday') jobs = await fetchWorkday(url, company.name)

      if (!jobs.length) {
        // Rule 6: The "Empty Company" Rule
        // If we found zero jobs, we still need the companyId to clean up old jobs
        const slug = company.name
          .toLowerCase()
          .replace(/[^a-z0-9]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
          
        const companyId = await upsertCompany({
          name: company.name,
          slug,
          website: company.website || null,
          industry: company.industry_category || company.industry || null,
          country: 'India',
          atsProvider: provider,
          atsToken: token,
          atsUrl: url,
          source: 'openjobs'
        })
        
        if (companyId) {
          await cleanupMissingJobs(companyId, [])
        }
        
        processed++
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
        industry: company.industry_category || company.industry || null,
        country: 'India',
        atsProvider: provider,
        atsToken: token,
        atsUrl: url,
        source: 'openjobs'
      })

      if (!companyId) {
        processed++
        continue
      }

      const jobsWithCompany = jobs.map((j) => ({ ...j, company_id: companyId }))
      const count = await upsertJobs(jobsWithCompany)
      totalJobs += count

      // Rule 6: Cleanup Missing Jobs
      const currentIds = jobs.map(j => j.external_id)
      await cleanupMissingJobs(companyId, currentIds)

      processed++

      // Be polite to ATS APIs — 300ms between requests
      await new Promise((r) => setTimeout(r, 300))

      if (processed % 50 === 0) {
        console.log(
          `  Progress: ${processed}/${targets.length} companies | ${totalJobs} jobs so far`
        )
      }
    } catch (err) {
      console.error(`  ✗ ${company.name}:`, err.message)
      processed++
    }
  }

  console.log(`  Skipped (no routable ATS): ${skipped}`)
  await expireOldJobs(30)
  await logRun('openjobs', totalJobs, 'success')
  console.log(`✅ Done! ${totalJobs} jobs synced from OpenJobs`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
