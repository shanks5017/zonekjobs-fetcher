/**
 * linkedin.mjs — LinkedIn Company Profile URL Resolver
 *
 * Strategy (waterfall, no login required):
 *  1. Clearbit Enrichment API (if CLEARBIT_API_KEY is set) → cleanest source
 *  2. Slug guess from company name → HTTP 200 check on linkedin.com/company/{slug}
 *  3. Slug guess from domain     → HTTP 200 check
 *  4. null if nothing resolves
 *
 * Important: We do NOT scrape LinkedIn pages — we only check if a canonical
 * URL returns HTTP 200 (public company pages do without login).
 * LinkedIn does rate-limit aggressive HEAD checks, so we use the polite delay
 * in run.mjs between companies.
 */

const LINKEDIN_BASE = 'https://www.linkedin.com/company'
const TIMEOUT_MS    = 8000

/**
 * Check if a LinkedIn company URL exists (returns 200 without login).
 * LinkedIn public company pages ARE accessible without auth.
 *
 * @param {string} slug
 * @returns {Promise<string|null>}  Full URL if found, null otherwise
 */
async function checkLinkedInSlug(slug) {
  if (!slug) return null
  const url = `${LINKEDIN_BASE}/${slug}/`
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml'
      }
    })
    clearTimeout(timer)
    // 200 = found, 999 = LinkedIn rate-limit (treat as "exists"),
    // 404 = definitely not found, others = uncertain
    if (res.status === 200 || res.status === 999) return url
    return null
  } catch {
    return null
  }
}

/**
 * Convert a company name to a LinkedIn-style slug.
 * e.g. "Razorpay Software Pvt Ltd" → "razorpay"
 *      "Johnson & Johnson"         → "johnson-johnson"
 *      "Tata Consultancy Services" → "tata-consultancy-services"
 *
 * @param {string} name
 * @returns {string[]}  Multiple slug candidates to try
 */
function generateSlugCandidates(name) {
  const candidates = new Set()

  // Clean common legal suffixes first
  const clean = name
    .replace(/\b(private|pvt|ltd|limited|inc|llc|llp|corp|corporation|technologies|technology|solutions|services|group|holdings|international)\b\.?/gi, '')
    .trim()

  // Full name slug
  const fullSlug = name
    .toLowerCase()
    .replace(/[&+]/g, '-and-')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  // Cleaned slug (without legal suffixes)
  const cleanSlug = clean
    .toLowerCase()
    .replace(/[&+]/g, '-and-')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  // First word only (often matches for well-known brands)
  const firstWord = cleanSlug.split('-')[0]

  if (fullSlug)  candidates.add(fullSlug)
  if (cleanSlug) candidates.add(cleanSlug)
  if (firstWord && firstWord.length > 2) candidates.add(firstWord)

  return [...candidates]
}

/**
 * Extract a slug from a company domain.
 * e.g. "razorpay.com" → "razorpay"
 *      "careers.google.com" → "google"
 *
 * @param {string} domain
 * @returns {string|null}
 */
function slugFromDomain(domain) {
  if (!domain) return null
  try {
    // Remove TLD and common prefixes
    const parts = domain.replace(/^www\./, '').split('.')
    return parts[0] || null
  } catch {
    return null
  }
}

/**
 * Main LinkedIn resolver. Returns a valid linkedin.com/company/{slug} URL or null.
 *
 * @param {object} opts
 * @param {string} opts.companyName
 * @param {string} [opts.domain]
 * @param {string} [opts.clearbitLinkedInHandle]  - from Clearbit Enrichment API
 * @returns {Promise<string|null>}
 */
export async function getLinkedIn({ companyName, domain, clearbitLinkedInHandle }) {
  // 1. Clearbit Enrichment API result (most reliable)
  if (clearbitLinkedInHandle) {
    const handle = clearbitLinkedInHandle.replace(/^linkedin\.com\/company\//i, '').replace(/\/$/, '')
    const verified = await checkLinkedInSlug(handle)
    if (verified) return verified
  }

  // 2. Slug from domain (very reliable for single-word domains)
  const domainSlug = slugFromDomain(domain)
  if (domainSlug) {
    const verified = await checkLinkedInSlug(domainSlug)
    if (verified) return verified
  }

  // 3. Name-based slug candidates
  const nameCandidates = generateSlugCandidates(companyName)
  for (const slug of nameCandidates) {
    // Skip if we already tried this (same as domainSlug)
    if (slug === domainSlug) continue
    const verified = await checkLinkedInSlug(slug)
    if (verified) return verified
  }

  return null
}
