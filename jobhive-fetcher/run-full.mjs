/**
 * Jobhive Full-Scale Pipeline → Supabase
 * Reads ALL companies from ats-scrapers/ats-companies/*.csv and upserts to Supabase.
 *
 * Features:
 *  - Checkpoint/resume: saves progress so crashes don't restart from scratch
 *  - Retry with exponential backoff (3 attempts per company)
 *  - Concurrent workers (default 4, tune via --concurrency)
 *  - Rotatable by ATS via --ats flag
 *
 * Usage:
 *   node --env-file=.env jobhive-fetcher/run-full.mjs --ats greenhouse
 *   node --env-file=.env jobhive-fetcher/run-full.mjs --ats "greenhouse,lever,ashby"
 *   node --env-file=.env jobhive-fetcher/run-full.mjs --ats all --concurrency 4
 *   node --env-file=.env jobhive-fetcher/run-full.mjs --ats greenhouse --resume
 *   node --env-file=.env jobhive-fetcher/run-full.mjs --ats greenhouse --limit 500
 */

import { existsSync, readFileSync, writeFileSync, createReadStream } from 'fs'
import { createInterface } from 'readline'
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

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

// ─── PATHS ───────────────────────────────────────────────────────────────────
const ATS_SCRAPERS_DIR = path.resolve(__dirname, '../../ats-scrapers')
const ATS_COMPANIES_DIR = path.join(ATS_SCRAPERS_DIR, 'ats-companies')
const CHECKPOINT_FILE = path.join(__dirname, '.checkpoint.json')
const VENV_BINARY = path.join(ATS_SCRAPERS_DIR, '.venv/Scripts/jobhive.exe')
const VENV_BINARY_UNIX = path.join(ATS_SCRAPERS_DIR, '.venv/bin/jobhive')

function getJobhiveBinary() {
  if (existsSync(VENV_BINARY)) return VENV_BINARY
  if (existsSync(VENV_BINARY_UNIX)) return VENV_BINARY_UNIX
  return 'jobhive' // GitHub Actions global install
}

// ─── CHECKPOINT ───────────────────────────────────────────────────────────────
function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return {}
  try { return JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf-8')) } catch { return {} }
}
function saveCheckpoint(cp) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2))
}

// ─── CSV READER ───────────────────────────────────────────────────────────────
async function readCSV(filePath) {
  const rows = []
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity })
  let headers = null
  for await (const line of rl) {
    if (!line.trim()) continue
    const cols = line.split(',').map(c => c.trim().replace(/^"|"$/g, ''))
    if (!headers) { headers = cols; continue }
    const row = {}
    headers.forEach((h, i) => { row[h] = cols[i] || '' })
    rows.push(row)
  }
  return rows
}

// ─── TOKEN EXTRACTOR (mirrors run_pipeline.py slug logic) ─────────────────────
function extractToken(ats, row) {
  const slug = (row.slug || '').trim()
  const url  = (row.url  || '').trim()
  const name = (row.name || '').trim()

  if (slug) return slug
  if (!url)  return name || null

  // ATS-specific extraction
  const patterns = {
    greenhouse:      /boards(?:-api)?\.greenhouse\.io\/(?:v\d\/boards\/)?([^/?#]+)/,
    lever:           /jobs\.lever\.co\/([^/?#]+)/,
    ashby:           /jobs\.ashbyhq\.com\/([^/?#]+)/,
    smartrecruiters: null,  // use name directly
    successfactors:  null,  // use full URL
    workday:         null,  // use full URL
    bamboohr:        /([^.]+)\.bamboohr\.com/,
    breezy:          /([^.]+)\.breezy\.hr/,
    recruitee:       /([^.]+)\.recruitee\.com/,
    personio:        /([^.]+)\.jobs\.personio\./,
    rippling:        /ats\.rippling\.com\/([^/?#]+)/,
    jazzhr:          /([^.]+)\.applytojob\.com/,
    teamtailor:      null,  // use name
    cornerstone:     null,  // use slug or url
    icims:           /careers-([a-z0-9-]+)\.icims\.com/,
    join_com:        /join\.com\/companies\/([^/?#]+)/,
    gem:             /jobs\.gem\.com\/([^/?#]+)/,
    eightfold:       /([^.]+)\.eightfold\.ai/,
    oracle:          null,  // use full URL
    phenom:          null,  // use full URL
    pinpoint:        null,  // use name
    workable:        /apply\.workable\.com\/([^/?#]+)/,
    gem:             null,
    recruiterbox:    null,
    avature:         /([^.]+)\.avature\.net/,
    taleo:           null,  // use full URL
  }

  // ATSes that use full URL as token
  const useFullUrl = ['workday', 'successfactors', 'oracle', 'phenom', 'taleo']
  if (useFullUrl.includes(ats)) return url || name || null

  // ATSes that use name as token
  const useName = ['smartrecruiters', 'teamtailor', 'pinpoint', 'recruiterbox', 'gem', 'join_com', 'mercor']
  if (useName.includes(ats)) return name || null

  const pattern = patterns[ats]
  if (pattern) {
    const m = url.match(pattern)
    if (m) return m[1].toLowerCase()
  }

  return name || null
}

// ─── FIELD MAPPER ────────────────────────────────────────────────────────────
function normalizeJobType(employment_type, title, commitment) {
  const et = (employment_type || '').toUpperCase()
  const t  = (title || '').toLowerCase()
  const c  = (commitment || '').toLowerCase()
  if (et === 'INTERN'    || t.includes('intern')    || c.includes('intern'))    return 'internship'
  if (et === 'PART_TIME' || t.includes('part-time'))                            return 'parttime'
  if (et === 'CONTRACT'  || t.includes('contract'))                             return 'contract'
  return 'fulltime'
}

function mapJobs(rawJobs) {
  return rawJobs.map(job => {
    const loc = job.location || null
    const t   = (job.title || '').toLowerCase()
    const desc = cleanDescription(job.description)
    const parsedExp = parseExperience(job.title, desc)
    const expLevel = inferExperienceLevel(job.title, desc, parsedExp)
    const parsedSalary = parseSalary(job.title, desc)

    const salaryMin = job.salary_min ?? parsedSalary.salary_min ?? null
    const salaryMax = job.salary_max ?? parsedSalary.salary_max ?? null
    const salaryCurrency = job.salary_currency ?? parsedSalary.salary_currency ?? null
    const salaryAvg = (salaryMin && salaryMax) ? Math.round((salaryMin + salaryMax) / 2) : null

    return {
      external_id:      String(job.ats_id || job.global_id),
      ats_provider:     job.ats_type,
      apply_url:        String(job.apply_url || job.url || ''),
      title:            job.title,
      description:      desc,
      location:         loc,
      country:          job.country_iso || null,
      is_remote:        job.is_remote ?? (t.includes('remote') || (loc || '').toLowerCase().includes('remote')),
      job_type:         normalizeJobType(job.employment_type, job.title, job.commitment),
      experience:       parsedExp,
      experience_level: expLevel,
      department:       job.department || null,
      salary_min:       salaryMin,
      salary_max:       salaryMax,
      salary_currency:  salaryCurrency,
      salary_avg:       salaryAvg,
      posted_at:        job.posted_at ? new Date(job.posted_at).toISOString() : null,
      fetched_at:       new Date().toISOString(),
      is_active:        true,
      source_repo:      'jobhive',
    }
  })
}

// ─── INDIA / REMOTE JOB-LEVEL FILTER ────────────────────────────────────────────────
// Runs per-job after mapping — only India-located or Remote jobs are stored.
// This is the final quality gate for the full-scale CSV pipeline.
const INDIA_SIGNALS  = ['india', 'bengaluru', 'bangalore', 'mumbai', 'delhi', 'hyderabad',
                        'pune', 'chennai', 'kolkata', 'noida', 'gurugram', 'gurgaon']
const REMOTE_SIGNALS = ['remote', 'worldwide', 'global', 'anywhere', 'work from home', 'wfh']

function isIndiaOrRemoteJob(job) {
  const loc        = (job.location || '').toLowerCase()
  const country    = (job.country  || '').toLowerCase()
  const title      = (job.title    || '').toLowerCase()
  const countryIso = (job.country_iso || '').toLowerCase()

  if (job.is_remote === true) return true
  if (countryIso === 'in')    return true

  const haystack = `${loc} ${country} ${title}`
  if (INDIA_SIGNALS.some(s  => haystack.includes(s))) return true
  if (REMOTE_SIGNALS.some(s => haystack.includes(s))) return true

  return false
}

// ─── SINGLE COMPANY SCRAPE WITH RETRY ─────────────────────────────────────────
async function scrapeWithRetry(binary, ats, token, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { stdout } = await execFileAsync(
        binary, ['scrape', ats, token, '--format', 'json'],
        { maxBuffer: 30 * 1024 * 1024, timeout: 60000 }
      )
      const parsed = JSON.parse(stdout.trim())
      return Array.isArray(parsed) ? parsed : []
    } catch (err) {
      const msg = (err.stderr?.trim() || err.message).split('\n')[0]
      const isRetryable = !msg.includes('not found') && !msg.includes('404')
      if (!isRetryable || attempt === maxRetries) {
        return { error: msg }
      }
      const wait = Math.pow(2, attempt) * 1000
      await new Promise(r => setTimeout(r, wait))
    }
  }
  return { error: 'max retries exceeded' }
}

// ─── CONCURRENCY POOL ────────────────────────────────────────────────────────
async function pool(tasks, concurrency) {
  const results = []
  let i = 0
  async function worker() {
    while (i < tasks.length) {
      const idx = i++
      results[idx] = await tasks[idx]()
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  return results
}

// ─── ATS LIST ────────────────────────────────────────────────────────────────
// Priority order: highest jobs-per-company first
const ATS_PRIORITY = [
  'workday',         // 658K jobs / 2616 companies = ~250/co
  'greenhouse',      // 169K / 5004 = ~34/co
  'smartrecruiters', // 212K / 24603 = ~8/co (many companies)
  'lever',           // 68K  / 2296  = ~30/co
  'icims',           // 118K / 1369  = ~86/co
  'jazzhr',          // 71K  / 2691  = ~26/co
  'ashby',           // 44K  / 2880  = ~15/co
  'join_com',        // 50K  / 23571 = ~2/co
  'bamboohr',        // 20K  / 6288  = ~3/co
  'teamtailor',      // 15K  / 1120  = ~13/co
  'rippling',        // 14K  / 1934  = ~7/co
  'successfactors',  // 181K / 722   = ~250/co
  'personio',        // 14K  / 2480  = ~5/co
  'cornerstone',     // 10K  / 253   = ~39/co
  'breezy',          // 5K   / 1389  = ~3/co
  'recruitee',
  'workable',
  'oracle',
  'eightfold',
  'phenom',
  'pinpoint',
  'gem',
  'avature',
  'recruiterbox',
  'taleo',
  'mercor',
]

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2)
  const getArg = (flag, def) => {
    const i = args.indexOf(flag)
    return i !== -1 ? args[i + 1] : def
  }
  const hasFlag = (flag) => args.includes(flag)

  const atsArg     = getArg('--ats', 'greenhouse')
  const concurrency = parseInt(getArg('--concurrency', '4'), 10)
  const limit       = parseInt(getArg('--limit', '0'), 10)
  const resume      = hasFlag('--resume')

  // Resolve which ATSes to process
  const selectedAts = atsArg === 'all'
    ? ATS_PRIORITY
    : atsArg.split(',').map(s => s.trim())

  const binary = getJobhiveBinary()
  console.log(`🚀 Jobhive Full Pipeline`)
  console.log(`   Binary   : ${binary}`)
  console.log(`   ATS      : ${selectedAts.join(', ')}`)
  console.log(`   Workers  : ${concurrency}`)
  console.log(`   Resume   : ${resume}`)
  console.log(`   Limit    : ${limit || 'none'}\n`)

  const checkpoint = resume ? loadCheckpoint() : {}
  let grandTotal = 0
  let grandErrors = 0
  let grandSkipped = 0

  for (const ats of selectedAts) {
    const csvPath = path.join(ATS_COMPANIES_DIR, `${ats}.csv`)
    if (!existsSync(csvPath)) {
      console.log(`⚠️  No CSV for "${ats}" — skipping`)
      continue
    }

    let companies = await readCSV(csvPath)
    if (!companies.length) { console.log(`⚠️  Empty CSV: ${ats}`); continue }

    // Resume: skip already processed tokens
    const done = new Set(checkpoint[ats]?.done || [])
    const failedPrev = new Set(checkpoint[ats]?.failed || [])
    if (resume) {
      companies = companies.filter(r => {
        const tok = extractToken(ats, r)
        return tok && !done.has(tok)
      })
      console.log(`📂 ${ats}: ${companies.length} remaining (${done.size} already done)`)
    } else {
      console.log(`📂 ${ats}: ${companies.length} companies`)
    }

    if (limit > 0) companies = companies.slice(0, limit)

    if (!checkpoint[ats]) checkpoint[ats] = { done: [], failed: [] }

    let atsTotal = 0, atsErrors = 0, atsSkipped = 0
    let processed = 0
    const startTime = Date.now()

    // Build task list
    const tasks = companies.map(row => async () => {
      const token = extractToken(ats, row)
      const name  = (row.name || token || '').trim()

      if (!token) { atsSkipped++; return }

      const raw = await scrapeWithRetry(binary, ats, token)

      if (raw?.error) {
        // Permanent errors (board not found) → mark done to skip next resume
        const isPermanent = raw.error.includes('not found') || raw.error.includes('404')
        if (isPermanent) {
          checkpoint[ats].done.push(token)
        } else {
          checkpoint[ats].failed.push(token)
          atsErrors++
        }
        processed++
        return
      }

      try {
        if (!raw.length) {
          checkpoint[ats].done.push(token)
          processed++
          return
        }

        const mapped = mapJobs(raw)

        // ── India / Remote gate ─────────────────────────────────────────────────────
        const filteredMapped = mapped.filter(isIndiaOrRemoteJob)

        if (!filteredMapped.length) {
          checkpoint[ats].done.push(token)
          processed++
          return
        }

        const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
        console.log(`  🔍 Fetching logo/website for ${name}...`)
        const enrichedMeta = await getCompanyMetadata(name, ats, token)

        const companyId = await upsertCompany({
          name,
          slug,
          website:     enrichedMeta?.website || (row.url?.startsWith('http') ? row.url : null),
          logo_url:    enrichedMeta?.logo_url || null,
          industry:    null,
          country:     null,
          atsProvider: ats,
          atsToken:    token,
          atsUrl:      row.url || null,
          source:      'jobhive',
        })

        if (!companyId) { atsErrors++; processed++; return }

        const jobsToUpsert = filteredMapped.map(j => ({ ...j, company_id: companyId }))
        await upsertJobs(jobsToUpsert)
        await cleanupMissingJobs(companyId, jobsToUpsert.map(j => j.external_id))

        atsTotal += jobsToUpsert.length
        checkpoint[ats].done.push(token)
      } catch (err) {
        checkpoint[ats].failed.push(token)
        atsErrors++
      }

      processed++

      // Log progress every 100 companies + save checkpoint
      if (processed % 100 === 0) {
        const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
        const rate = (processed / ((Date.now() - startTime) / 1000)).toFixed(1)
        console.log(`  [${ats}] ${processed}/${companies.length} | ${atsTotal} jobs | ${elapsed}min | ${rate}/s`)
        saveCheckpoint(checkpoint)
      }
    })

    await pool(tasks, concurrency)

    // Final save
    saveCheckpoint(checkpoint)

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1)
    console.log(`✅ ${ats}: ${atsTotal} jobs | ${atsErrors} errors | ${atsSkipped} skipped | ${elapsed} min`)

    grandTotal   += atsTotal
    grandErrors  += atsErrors
    grandSkipped += atsSkipped
  }

  // Global cleanup of very old jobs
  await expireOldJobs(45)
  await logRun('jobhive-full', grandTotal, 'success')
  console.log(`\n🏁 DONE: ${grandTotal} jobs | ${grandErrors} errors | ${grandSkipped} skipped`)
}

main().catch(err => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
