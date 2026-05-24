/**
 * clearbit.mjs — Clearbit Autocomplete & Logo API integration
 *
 * Uses 100% FREE endpoints — no API key required:
 *   • Autocomplete API: returns {name, domain, logo} for a company name query
 *   • Logo API:         direct PNG image served from logo.clearbit.com/{domain}
 *
 * Clearbit Autocomplete also sometimes returns:
 *   • company type (B2B/B2C)
 *   • tags/industry hints
 * But NOT linkedin_handle on the free tier — that needs a paid Enrichment key.
 *
 * If you add CLEARBIT_API_KEY to .env, this module upgrades to the full
 * Enrichment API which returns: description, linkedin_handle, twitter_handle,
 * employee count, industry, and more.
 */

const CLEARBIT_AUTOCOMPLETE = 'https://autocomplete.clearbit.com/v1/companies/suggest'
const CLEARBIT_ENRICHMENT   = 'https://company.clearbit.com/v2/companies/find'
const CLEARBIT_LOGO_BASE    = 'https://logo.clearbit.com'

const TIMEOUT_MS = 8000

async function fetchJson(url, headers = {}) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ZonekJobsBot/1.0)',
        ...headers
      }
    })
    clearTimeout(timer)
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

/**
 * Look up a company via Clearbit's free Autocomplete API.
 * Returns the best-matching result or null.
 *
 * @param {string} companyName
 * @returns {Promise<{name, domain, logo}|null>}
 */
export async function clearbitAutocomplete(companyName) {
  const url = `${CLEARBIT_AUTOCOMPLETE}?query=${encodeURIComponent(companyName)}`
  const results = await fetchJson(url)
  if (!Array.isArray(results) || results.length === 0) return null

  // Pick the best match — prefer exact name match, fallback to first result
  const exactMatch = results.find(
    (r) => r.name?.toLowerCase() === companyName.toLowerCase()
  )
  return exactMatch || results[0]
}

/**
 * Full Enrichment API (requires CLEARBIT_API_KEY in .env).
 * Returns rich company data including linkedin_handle, description, etc.
 * Silently returns null if no API key is set or if the company isn't found.
 *
 * @param {string} domain
 * @returns {Promise<object|null>}
 */
export async function clearbitEnrich(domain) {
  const apiKey = process.env.CLEARBIT_API_KEY
  if (!apiKey) return null // gracefully skip if no key

  const url = `${CLEARBIT_ENRICHMENT}?domain=${encodeURIComponent(domain)}`
  const data = await fetchJson(url, {
    Authorization: `Bearer ${apiKey}`
  })
  return data || null
}

/**
 * Fetches the Clearbit logo URL for a domain.
 * Note: The actual validation of whether this URL is a real image should
 * be done by logo.mjs → isValidImage(). Clearbit returns 404 for unknown
 * companies, which isValidImage() will correctly reject.
 *
 * @param {string} domain
 * @returns {string}
 */
export function clearbitLogoUrl(domain) {
  return `${CLEARBIT_LOGO_BASE}/${domain}`
}

/**
 * Scrape the company homepage for OpenGraph / meta description as a fallback
 * "about" text when Clearbit doesn't have a description.
 *
 * @param {string} domain
 * @returns {Promise<string|null>}
 */
export async function scrapeAboutFromHomepage(domain) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)

    const res = await fetch(`https://${domain}`, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html'
      },
      redirect: 'follow'
    })
    clearTimeout(timer)

    if (!res.ok) return null
    const html = await res.text()

    // Priority order for extracting description:
    // 1. og:description (OpenGraph — highest quality, written for sharing)
    // 2. twitter:description
    // 3. meta name="description" (standard SEO meta)

    const patterns = [
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{20,500})["']/i,
      /<meta[^>]+content=["']([^"']{20,500})["'][^>]+property=["']og:description["']/i,
      /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']{20,500})["']/i,
      /<meta[^>]+content=["']([^"']{20,500})["'][^>]+name=["']twitter:description["']/i,
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']{20,500})["']/i,
      /<meta[^>]+content=["']([^"']{20,500})["'][^>]+name=["']description["']/i
    ]

    for (const pattern of patterns) {
      const match = html.match(pattern)
      if (match?.[1]) {
        return match[1]
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#39;/g, "'")
          .trim()
      }
    }

    return null
  } catch {
    return null
  }
}
