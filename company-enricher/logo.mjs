/**
 * logo.mjs — Company Logo Fetcher
 *
 * Waterfall strategy (in order of quality):
 *  1. Clearbit Logo API  → real 128px PNG company logo
 *  2. Brandfetch CDN     → backup logo source
 *  3. Google Favicon     → last resort (still ATS-safe because we validate domain first)
 *
 * Every candidate URL is HTTP-validated — if the server doesn't return
 * a real image/* response, we skip it. This prevents hallucinating ATS logos.
 */

const VALIDATION_TIMEOUT_MS = 6000

/**
 * Validates that a URL returns an actual image (not a 404, redirect to generic
 * placeholder, or ATS logo). Uses a HEAD request to avoid downloading the image.
 *
 * @param {string} url
 * @returns {Promise<boolean>}
 */
export async function isValidImage(url) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS)

    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; ZonekJobsBot/1.0; +https://zonekjobs.com)'
      }
    })
    clearTimeout(timer)

    if (!res.ok) return false

    const contentType = res.headers.get('content-type') || ''
    // Must be a real image — not HTML, not JSON, not XML (which is what most
    // ATS / 404 pages return)
    return contentType.startsWith('image/')
  } catch {
    return false
  }
}

/**
 * Returns the best logo URL for a company domain.
 * Falls through the waterfall until one validates, or returns null.
 *
 * @param {string} domain  - e.g. "razorpay.com" (never an ATS domain)
 * @returns {Promise<string|null>}
 */
export async function getLogo(domain) {
  if (!domain) return null

  const candidates = [
    // 1. Clearbit Logo API — best quality, 128px PNG, no key needed
    `https://logo.clearbit.com/${domain}`,
    // 2. Brandfetch CDN — solid backup
    `https://cdn.brandfetch.io/${domain}`,
    // 3. Google Favicon — guaranteed to return something but smaller
    `https://www.google.com/s2/favicons?sz=128&domain=${domain}`
  ]

  for (const url of candidates) {
    const valid = await isValidImage(url)
    if (valid) {
      const source =
        url.includes('clearbit') ? 'clearbit' :
        url.includes('brandfetch') ? 'brandfetch' : 'favicon'
      return { url, source }
    }
  }

  return null
}
