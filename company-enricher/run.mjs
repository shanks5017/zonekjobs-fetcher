/**
 * company-enricher/run.mjs — Company Details Enrichment Pipeline
 *
 * Fetches for every company in Supabase:
 *   ✦ logo_url   — Real company logo (Clearbit → Brandfetch → Favicon fallback)
 *   ✦ about      — Company description (Clearbit → OpenGraph scrape)
 *   ✦ website    — Clean https:// URL (never an ATS portal)
 *   ✦ linkedin_url — linkedin.com/company/{slug} (Clearbit → slug waterfall)
 *
 * Anti-hallucination guarantee:
 *   • ATS domains are stripped before any logo/about lookup
 *   • Every logo URL is HTTP-validated (must return image/*)
 *   • Clearbit 404s are caught and fall through gracefully
 *
 * Run: node --env-file=.env company-enricher/run.mjs
 * Options:
 *   --limit N       Process at most N companies (default: 100)
 *   --force         Re-enrich already-enriched companies
 *   --company NAME  Enrich only companies matching NAME (partial, case-insensitive)
 *   --dry-run       Print what would happen without writing to Supabase
 */

import { getUnenrichedCompanies, getAllCompanies, updateCompanyEnrichment } from '../shared/supabase.mjs'
import { getLogo } from './logo.mjs'
import { clearbitAutocomplete, clearbitEnrich, scrapeAboutFromHomepage } from './clearbit.mjs'
import { getLinkedIn } from './linkedin.mjs'

// ─── CLI ARGS ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const LIMIT     = parseInt(args[args.indexOf('--limit') + 1]  || '') || 100
const FORCE     = args.includes('--force')
const DRY_RUN   = args.includes('--dry-run')
const NAME_FILTER = args.includes('--company')
  ? args[args.indexOf('--company') + 1]?.toLowerCase()
  : null

// ─── ATS DOMAIN BLOCKER ───────────────────────────────────────────────────────
// These domains MUST NEVER be used as the company's real domain.
// If we detect one here, we fall back to name-based domain guessing.
const ATS_DOMAINS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com',
  'workdayjobs', 'workday.com', 'smartrecruiters.com', 'recruitee.com',
  'bamboohr.com', 'breezy.hr', 'avature.net', 'eightfold.ai', 'gem.com',
  'icims.com', 'applytojob.com', 'join.com', 'personio.de', 'personio.com',
  'personio.co.uk', 'rippling.com', 'recruiterbox.com', 'jobs2web.com',
  'taleo.net', 'teamtailor.com', 'workable.com', 'cornerstoneondemand.com',
  'jobvite.com', 'successfactors.eu', 'successfactors.com', 'sap.com'
]

function isAtsDomain(domain) {
  if (!domain) return false
  return ATS_DOMAINS.some(ats => domain.toLowerCase().includes(ats))
}

// ─── DOMAIN RESOLVER ──────────────────────────────────────────────────────────
// Extracts the real company domain from the company record.
// Never returns an ATS domain.
function resolveCompanyDomain(company) {
  // If we have a website field, try to extract its domain
  if (company.website) {
    try {
      const urlStr = company.website.startsWith('http')
        ? company.website
        : `https://${company.website}`
      const url = new URL(urlStr)
      const hostname = url.hostname.replace(/^www\./, '')
      if (!isAtsDomain(hostname)) return hostname
    } catch {
      // ignore parse errors
    }
  }

  // Fallback: guess domain from company name
  const cleanName = (company.name || '')
    .toLowerCase()
    .replace(/\b(private|pvt|ltd|limited|inc|llc|llp|corp|corporation|technologies|technology|solutions|services|group|holdings|international)\b\.?/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .trim()

  return cleanName ? `${cleanName}.com` : null
}

// ─── WEBSITE RESOLVER ─────────────────────────────────────────────────────────
// Returns a clean https:// URL. If the stored website is an ATS portal,
// we fall back to guessing from the domain.
function resolveWebsite(company, realDomain) {
  if (company.website) {
    try {
      const urlStr = company.website.startsWith('http')
        ? company.website
        : `https://${company.website}`
      const url = new URL(urlStr)
      const hostname = url.hostname.replace(/^www\./, '')
      if (!isAtsDomain(hostname)) return `https://${hostname}`
    } catch {}
  }
  return realDomain ? `https://${realDomain}` : null
}

// ─── MAIN ENRICHMENT FUNCTION ─────────────────────────────────────────────────
async function enrichCompany(company) {
  const result = {
    logo_url:    null,
    about:       null,
    website:     null,
    linkedin_url: null,
    logoSource:  null,
    aboutSource: null,
    linkedinSource: null
  }

  // Step 1: Resolve real company domain (never ATS)
  const domain = resolveCompanyDomain(company)
  result.website = resolveWebsite(company, domain)

  // Step 2: Try Clearbit Autocomplete (free, no key needed)
  let clearbitData = null
  if (company.name) {
    clearbitData = await clearbitAutocomplete(company.name)
    // If Clearbit returned a different (better) domain, prefer it
    if (clearbitData?.domain && !isAtsDomain(clearbitData.domain)) {
      const clearbitDomain = clearbitData.domain.replace(/^www\./, '')
      // Update domain and website with Clearbit's verified domain
      if (!isAtsDomain(clearbitDomain)) {
        result.website = `https://${clearbitDomain}`
      }
    }
  }

  // The canonical domain we'll use for logo/about/linkedin
  const canonicalDomain = (() => {
    if (clearbitData?.domain && !isAtsDomain(clearbitData.domain)) {
      return clearbitData.domain.replace(/^www\./, '')
    }
    return domain
  })()

  // Step 3: Try Clearbit Enrichment API (only if CLEARBIT_API_KEY set)
  let enrichData = null
  if (canonicalDomain) {
    enrichData = await clearbitEnrich(canonicalDomain)
  }

  // Step 4: Resolve logo (waterfall: clearbit → brandfetch → favicon)
  const logoResult = canonicalDomain ? await getLogo(canonicalDomain) : null
  if (logoResult) {
    result.logo_url = logoResult.url
    result.logoSource = logoResult.source
  }

  // Step 5: Resolve about/description
  // Priority: Clearbit Enrichment → Clearbit Autocomplete → OG scrape
  if (enrichData?.description) {
    result.about = enrichData.description
    result.aboutSource = 'clearbit-enrichment'
  } else if (canonicalDomain) {
    const ogAbout = await scrapeAboutFromHomepage(canonicalDomain)
    if (ogAbout) {
      result.about = ogAbout
      result.aboutSource = 'og-scrape'
    }
  }

  // Step 6: Resolve LinkedIn
  const linkedinUrl = await getLinkedIn({
    companyName:          company.name,
    domain:               canonicalDomain,
    clearbitLinkedInHandle: enrichData?.linkedin_handle || null
  })
  if (linkedinUrl) {
    result.linkedin_url    = linkedinUrl
    result.linkedinSource  = enrichData?.linkedin_handle ? 'clearbit' : 'slug-guess'
  }

  return result
}

// ─── STATS TRACKER ────────────────────────────────────────────────────────────
const stats = {
  total: 0, enriched: 0, skipped: 0, failed: 0,
  logo:    { clearbit: 0, brandfetch: 0, favicon: 0, none: 0 },
  about:   { 'clearbit-enrichment': 0, 'og-scrape': 0, none: 0 },
  linkedin: { clearbit: 0, 'slug-guess': 0, none: 0 }
}

function trackResult(enriched) {
  const ls = enriched.logoSource    || 'none'
  const as = enriched.aboutSource   || 'none'
  const qs = enriched.linkedinSource || 'none'
  stats.logo[ls]    = (stats.logo[ls]    || 0) + 1
  stats.about[as]   = (stats.about[as]   || 0) + 1
  stats.linkedin[qs] = (stats.linkedin[qs] || 0) + 1
}

function printSummary() {
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  🏁 Enrichment Complete
  Total    : ${stats.total}
  Enriched : ${stats.enriched}
  Skipped  : ${stats.skipped}
  Failed   : ${stats.failed}

  Logo sources:
    clearbit   : ${stats.logo.clearbit}
    brandfetch : ${stats.logo.brandfetch}
    favicon    : ${stats.logo.favicon}
    none       : ${stats.logo.none}

  About sources:
    clearbit-enrichment : ${stats.about['clearbit-enrichment']}
    og-scrape           : ${stats.about['og-scrape']}
    none                : ${stats.about.none}

  LinkedIn sources:
    clearbit   : ${stats.linkedin.clearbit}
    slug-guess : ${stats.linkedin['slug-guess']}
    none       : ${stats.linkedin.none}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `)
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔍 Company Enricher starting...')
  if (DRY_RUN)   console.log('  ⚠  DRY RUN — no Supabase writes')
  if (FORCE)     console.log('  ⚠  FORCE — re-enriching already-enriched companies')
  if (NAME_FILTER) console.log(`  🔎 Filtering by name: "${NAME_FILTER}"`)
  console.log(`  📦 Limit: ${LIMIT} companies\n`)

  // Fetch companies from Supabase
  let companies = FORCE
    ? await getAllCompanies(LIMIT)
    : await getUnenrichedCompanies(LIMIT)

  if (!companies?.length) {
    console.log('✅ No companies to enrich. All done!')
    return
  }

  // Apply name filter if specified
  if (NAME_FILTER) {
    companies = companies.filter(c =>
      c.name?.toLowerCase().includes(NAME_FILTER)
    )
    console.log(`  Filtered to ${companies.length} companies matching "${NAME_FILTER}"\n`)
  }

  stats.total = companies.length
  console.log(`  Processing ${companies.length} companies...\n`)

  for (const company of companies) {
    try {
      process.stdout.write(`  ⏳ ${company.name}...`)

      const enriched = await enrichCompany(company)
      trackResult(enriched)

      const logoTag    = enriched.logo_url    ? `logo=${enriched.logoSource}`          : 'logo=none'
      const aboutTag   = enriched.about       ? `about=${enriched.aboutSource}`        : 'about=none'
      const linkedinTag = enriched.linkedin_url ? `linkedin=${enriched.linkedinSource}` : 'linkedin=none'

      if (!DRY_RUN) {
        await updateCompanyEnrichment(company.id, {
          logo_url:     enriched.logo_url,
          about:        enriched.about,
          website:      enriched.website,
          linkedin_url: enriched.linkedin_url
        })
      }

      stats.enriched++
      console.log(` ✓  [${logoTag}] [${aboutTag}] [${linkedinTag}]`)

    } catch (err) {
      stats.failed++
      console.log(` ✗  ${err.message}`)
    }

    // Polite delay — avoid hammering Clearbit/LinkedIn
    await new Promise(r => setTimeout(r, 500))
  }

  printSummary()
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
