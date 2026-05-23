/**
 * Jobful (FreeJobAlert) Fetcher -> Supabase
 * Integrates jobful-api-master to scrape Indian Government and Public Sector jobs.
 * 
 * Supports local testing:
 *   node --env-file=.env jobful-fetcher/run.mjs --dry-run
 */

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'
import * as cheerio from 'cheerio'

const require = createRequire(import.meta.url)
const scraper = require('../jobful-api-master/customModules/freejobalerts/scraper.js')
const stateCodes = require('../jobful-api-master/data/freeJobAlertStateMap.json')

import { upsertCompany, upsertJobs, expireOldJobs, logRun } from '../shared/supabase.mjs'

const ALL_INDIA_CATEGORIES = [
  { name: 'Banking', url: 'https://www.freejobalert.com/bank-jobs/', tableNo: 1 },
  { name: 'Railways', url: 'https://www.freejobalert.com/railway-jobs/', tableNo: 1 },
  { name: 'Engineering', url: 'https://www.freejobalert.com/engineering-jobs/', tableNo: 1 },
  { name: 'Teaching', url: 'https://www.freejobalert.com/teaching-faculty-jobs/', tableNo: 2 },
  { name: 'Defence/Police', url: 'https://www.freejobalert.com/police-defence-jobs/', tableNo: 1 },
  { name: 'Other All India', url: 'https://www.freejobalert.com/government-jobs/', tableNo: 4 }
]

function parseDate(dateStr) {
  if (!dateStr) return new Date().toISOString()
  // Clean date string
  const cleanStr = dateStr.trim().replace(/[^\d-]/g, '')
  const parts = cleanStr.split('-')
  if (parts.length === 3) {
    const day = parseInt(parts[0], 10)
    const month = parseInt(parts[1], 10) - 1
    const year = parseInt(parts[2], 10)
    // Make sure we have 4 digit year
    const fullYear = year < 100 ? 2000 + year : year
    const d = new Date(fullYear, month, day)
    if (!isNaN(d.getTime())) {
      return d.toISOString()
    }
  }
  return new Date().toISOString()
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchJobDescription(url) {
  if (!url || !url.startsWith('http')) return 'No detailed job description provided.'
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
    if (!res.ok) return 'No detailed job description provided.'
    const html = await res.text()
    const $ = cheerio.load(html)
    
    // Get paragraphs inside entry-content or post
    const paragraphs = $('.entry-content p, .post p').toArray()
    const cleanParagraphs = []
    
    for (const p of paragraphs) {
      const text = $(p).text().trim()
      if (!text) continue
      
      const lower = text.toLowerCase()
      // Skip promotional / social / app links
      if (
        lower.includes('whatsapp') ||
        lower.includes('telegram') ||
        lower.includes('instagram') ||
        lower.includes('youtube') ||
        lower.includes('google news') ||
        lower.includes('follow us') ||
        lower.includes('mobile app') ||
        lower.includes('play fun games') ||
        lower.startsWith('advertisement') ||
        lower.includes('adsbygoogle')
      ) {
        continue
      }
      
      cleanParagraphs.push(text)
    }
    
    // Fallback: If no paragraphs found, get table text summary
    if (cleanParagraphs.length === 0) {
      const tableText = $('.entry-content table, .post table').first().text().trim()
      if (tableText) {
        return tableText.replace(/\s+/g, ' ').slice(0, 2000)
      }
    }
    
    const desc = cleanParagraphs.slice(0, 6).join('\n\n')
    return desc || 'No detailed job description provided.'
    
  } catch (err) {
    console.error(`  ⚠️ Failed to fetch description from ${url}:`, err.message)
    return 'No detailed job description provided.'
  }
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run')
  if (isDryRun) {
    console.log('🧪 DRY RUN MODE — No writes will be made to Supabase')
  }

  console.log('🚀 Starting FreeJobAlert sync...')

  const allScrapedJobs = []

  // 1. Scrape All India Categories
  console.log('\n--- Scraping All India Categories ---')
  for (const category of ALL_INDIA_CATEGORIES) {
    console.log(`Fetching category: ${category.name} from ${category.url}...`)
    try {
      const data = await scraper.topicScraper(category.url, category.name, category.tableNo)
      if (data && Array.isArray(data)) {
        let validCount = 0
        for (const item of data) {
          if (item && item.postName && item.postName.trim() && item.link) {
            allScrapedJobs.push({
              ...item,
              category: category.name,
              location: 'India'
            })
            validCount++
          }
        }
        console.log(`  ✓ Found ${data.length} jobs (kept ${validCount} valid)`)
      }
      // Be polite to the server
      await delay(500)
    } catch (err) {
      console.error(`  ✗ Error fetching category ${category.name}:`, err.message)
    }
  }

  // 2. Scrape State Government Jobs
  console.log('\n--- Scraping State Government Jobs ---')
  // For dry-run, only fetch first 2 states to verify setup quickly
  const statesToFetch = isDryRun ? stateCodes.slice(0, 2) : stateCodes
  for (const state of statesToFetch) {
    if (!state.link) continue
    console.log(`Fetching state: ${state.name} from ${state.link}...`)
    try {
      const data = await scraper.smartScraper(state.link, state.name)
      if (data && Array.isArray(data)) {
        let validCount = 0
        for (const item of data) {
          if (item && item.postName && item.postName.trim() && item.link) {
            allScrapedJobs.push({
              ...item,
              category: 'State Govt',
              location: state.name
            })
            validCount++
          }
        }
        console.log(`  ✓ Found ${data.length} jobs (kept ${validCount} valid)`)
      }
      // Be polite to the server
      await delay(500)
    } catch (err) {
      console.error(`  ✗ Error fetching state ${state.name}:`, err.message)
    }
  }

  console.log(`\n📊 Total jobs fetched from FreeJobAlert: ${allScrapedJobs.length}`)

  if (allScrapedJobs.length === 0) {
    console.log('⚠️ No jobs scraped. Exiting.')
    return
  }

  // Group jobs by board/employer to batch company upserts and job mapping
  const jobsByBoard = {}
  for (const job of allScrapedJobs) {
    const rawBoard = job.postBoard?.trim() || 'Government of India'
    // Normalize board name
    const board = rawBoard.replace(/\s+/g, ' ')
    if (!jobsByBoard[board]) {
      jobsByBoard[board] = []
    }
    jobsByBoard[board].push(job)
  }

  const boards = Object.keys(jobsByBoard)
  console.log(`Found ${boards.length} unique recruitment boards/employers.`)

  let totalUpserted = 0

  // 3. Process each recruitment board
  for (const board of boards) {
    const rawJobs = jobsByBoard[board]
    const companySlug = board
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')

    console.log(`\n🏢 Processing recruitment board: "${board}" (${rawJobs.length} jobs)`)

    // Map jobs to schema (fetch detailed description for each)
    const mappedJobs = []
    for (const j of rawJobs) {
      let cleanLink = j.link || 'https://www.freejobalert.com/'
      if (cleanLink && !cleanLink.startsWith('http')) {
        cleanLink = new URL(cleanLink, 'https://www.freejobalert.com/').toString()
      }

      const externalId = `fja-${companySlug}-${j.postName || ''}-${j.advtNo || ''}`
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')

      let description = 'No detailed job description provided.'
      if (cleanLink.startsWith('http')) {
        console.log(`  🔍 Fetching detailed description for: ${j.postName}...`)
        description = await fetchJobDescription(cleanLink)
        console.log(`    ↳ Preview: ${description.slice(0, 150).replace(/\n/g, ' ')}...`)
        // Be polite to the server
        await delay(200)
      }

      mappedJobs.push({
        company_id: null,
        external_id: externalId,
        title: j.postName || 'Government Job Opportunity',
        description: description,
        location: j.location || 'India',
        is_remote: false,
        apply_url: cleanLink,
        ats_provider: 'freejobalert',
        job_type: 'fulltime',
        department: j.qualification || null,
        posted_at: parseDate(j.postDate),
        fetched_at: new Date().toISOString(),
        is_active: true,
        source_repo: 'jobful-api'
      })
    }

    if (isDryRun) {
      console.log(`  [DRY RUN] Would upsert company: ${board}`)
      console.log(`  [DRY RUN] Would upsert ${mappedJobs.length} jobs`)
      totalUpserted += mappedJobs.length
      continue
    }

    try {
      // Upsert the recruitment board as a company in Supabase
      const companyId = await upsertCompany({
        name: board,
        slug: companySlug,
        website: null,
        industry: 'Government / Public Sector',
        country: 'India',
        atsProvider: 'freejobalert',
        atsToken: companySlug,
        atsUrl: 'https://www.freejobalert.com/',
        source: 'jobful-api'
      })

      if (!companyId) {
        console.log(`  ✗ Failed to upsert company for "${board}". Skipping jobs.`)
        continue
      }

      // Associate companyId
      const jobsWithCompany = mappedJobs.map(job => ({ ...job, company_id: companyId }))

      const count = await upsertJobs(jobsWithCompany)
      totalUpserted += count
      console.log(`  ✓ Successfully upserted ${count} jobs`)

    } catch (err) {
      console.error(`  ✗ Error processing board ${board}:`, err.message)
    }
  }

  if (!isDryRun) {
    await expireOldJobs(30)
    await logRun('jobful', totalUpserted, 'success')
  }

  console.log(`\n✅ Done! ${totalUpserted} jobs processed and synced.`)
}

main().catch((err) => {
  console.error('Fatal Error during FreeJobAlert sync:', err)
  process.exit(1)
})
