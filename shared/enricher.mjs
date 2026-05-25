import * as cheerio from 'cheerio'
import { chromium } from 'playwright'

const ATS_DOMAINS = [
  'greenhouse.io', 'greenhouse.com', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com',
  'workdayjobs', 'workday.com', 'smartrecruiters.com', 'recruitee.com',
  'bamboohr.com', 'breezy.hr', 'avature.net', 'eightfold.ai', 'gem.com',
  'icims.com', 'applytojob.com', 'join.com', 'personio.de', 'personio.com',
  'personio.co.uk', 'rippling.com', 'recruiterbox.com', 'jobs2web.com',
  'taleo.net', 'teamtailor.com', 'workable.com', 'cornerstoneondemand.com',
  'jobvite.com', 'successfactors.eu', 'successfactors.com', 'sap.com'
]

const SOCIAL_DOMAINS = [
  'linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'youtube.com',
  'instagram.com', 'glassdoor.com', 'github.com'
]

export function isAtsDomain(domain) {
  if (!domain) return false
  return ATS_DOMAINS.some(ats => domain.toLowerCase().includes(ats))
}

function cleanWebsiteUrl(urlStr) {
  if (!urlStr) return null
  try {
    const url = new URL(urlStr.trim())
    const hostname = url.hostname.toLowerCase()
    if (isAtsDomain(hostname)) return null
    if (SOCIAL_DOMAINS.some(s => hostname.includes(s))) return null
    
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

function cleanLogoUrl(urlStr, provider) {
  if (!urlStr) return null
  try {
    const url = new URL(urlStr.trim())
    const path = url.pathname.toLowerCase()
    const hostname = url.hostname.toLowerCase()

    if (path.includes('lever-logo-refresh.svg') || path.includes('wday-logo') || path.includes('greenhouse-logo')) {
      return null
    }
    if (hostname.includes('greenhouse.io') && !urlStr.includes('logos') && !urlStr.includes('job_board_configurations')) {
      return null
    }
    if (hostname.includes('lever.co') && !urlStr.includes('lever-client-logos')) {
      return null
    }
    if (hostname.includes('ashbyhq.com') && !urlStr.includes('org-theme-logo') && !urlStr.includes('images')) {
      return null
    }

    return url.toString()
  } catch {
    return null
  }
}

async function isValidImage(url) {
  if (!url) return false
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
    if (!res.ok) return false
    const contentType = (res.headers.get('content-type') || '').toLowerCase()
    if (contentType.startsWith('image/')) return true

    // Check if the URL has an image extension and content type is octet-stream or pdf (common S3 / Ashby misconfigs)
    const cleanUrl = url.split('?')[0].split('#')[0].toLowerCase()
    const isImageExt = cleanUrl.endsWith('.png') || 
                       cleanUrl.endsWith('.jpg') || 
                       cleanUrl.endsWith('.jpeg') || 
                       cleanUrl.endsWith('.gif') || 
                       cleanUrl.endsWith('.svg') || 
                       cleanUrl.endsWith('.webp') ||
                       cleanUrl.endsWith('.ico')

    if (isImageExt) {
      if (contentType.includes('octet-stream') || contentType.includes('pdf')) {
        return true
      }
    }
    return false
  } catch {
    return false
  }
}

// ─── CHEERIO SCRAPER (FAST) ──────────────────────────────────────────────────
async function scrapeCheerio(url, provider) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    })
    if (!res.ok) return null
    const html = await res.text()
    const $ = cheerio.load(html)

    let logo_url = null
    let website = null

    if (provider === 'greenhouse') {
      const logoImg = $('#logo img')
      if (logoImg.length) {
        logo_url = cleanLogoUrl(logoImg.attr('src'), 'greenhouse')
        const parentAnchor = logoImg.closest('a')
        if (parentAnchor.length) {
          website = cleanWebsiteUrl(parentAnchor.attr('href'))
        }
      }
      if (!website) {
        $('a').each((i, el) => {
          const href = $(el).attr('href')
          const text = $(el).text().toLowerCase()
          if (href && (text.includes('website') || text.includes('home'))) {
            website = cleanWebsiteUrl(href)
            if (website) return false // break loop
          }
        })
      }
    } else if (provider === 'lever') {
      $('img').each((i, el) => {
        const src = $(el).attr('src')
        const alt = $(el).attr('alt') || ''
        if (src && (alt.toLowerCase().includes('logo') || src.includes('lever-client-logos'))) {
          logo_url = cleanLogoUrl(src, 'lever')
          if (logo_url) return false
        }
      })
      $('a').each((i, el) => {
        const href = $(el).attr('href')
        const text = $(el).text().toLowerCase()
        if (href && (text.includes('home page') || text.includes('website') || $(el).hasClass('main-header-logo'))) {
          website = cleanWebsiteUrl(href)
          if (website) return false
        }
      })
    }

    return (logo_url || website) ? { logo_url, website } : null
  } catch (err) {
    console.error(`  ⚠️ [Cheerio] Scrape failed for ${url}:`, err.message)
    return null
  }
}

// ─── PLAYWRIGHT SCRAPER (FALLBACK) ───────────────────────────────────────────
async function scrapePlaywright(url, provider) {
  let browser
  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    })
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 })
    await page.waitForTimeout(2000)

    const data = await page.evaluate((prov) => {
      let logo = null
      let web = null

      const images = Array.from(document.querySelectorAll('img'))
      const links = Array.from(document.querySelectorAll('a'))

      if (prov === 'greenhouse') {
        const logoImg = document.querySelector('#logo img')
        if (logoImg) {
          logo = logoImg.src
          const parent = logoImg.closest('a')
          if (parent) web = parent.href
        }
        if (!web) {
          const webLink = links.find(a => a.innerText.toLowerCase().includes('website') || a.innerText.toLowerCase().includes('home'))
          if (webLink) web = webLink.href
        }
      } else if (prov === 'lever') {
        const clientLogo = images.find(img => img.src.includes('lever-client-logos') || img.alt.toLowerCase().includes('logo'))
        if (clientLogo) logo = clientLogo.src
        const homeLink = links.find(a => a.innerText.toLowerCase().includes('home page') || a.innerText.toLowerCase().includes('website'))
        if (homeLink) web = homeLink.href
      } else if (prov === 'ashby') {
        const logoImg = images.find(img => img.src.includes('org-theme-logo') || img.className.toLowerCase().includes('logo'))
        if (logoImg) logo = logoImg.src
        const webLink = links.find(a => {
          const href = a.href.toLowerCase()
          const isAts = href.includes('ashbyhq.com') || href.includes('greenhouse.io') || href.includes('lever.co')
          return href.startsWith('http') && !isAts && !a.innerText.toLowerCase().includes('privacy')
        })
        if (webLink) web = webLink.href
      } else if (prov === 'workday') {
        const logoImg = images.find(img => !img.src.includes('wday-logo') && !img.src.includes('workday.com') && (img.alt.toLowerCase().includes('logo') || img.id === 'logo'))
        if (logoImg) logo = logoImg.src
        const webLink = links.find(a => {
          const href = a.href.toLowerCase()
          return href.startsWith('http') && !href.includes('myworkdayjobs.com') && !href.includes('workday.com')
        })
        if (webLink) web = webLink.href
      }

      return { logo, web }
    }, provider)

    await browser.close()

    return {
      logo_url: cleanLogoUrl(data.logo, provider),
      website: cleanWebsiteUrl(data.web)
    }
  } catch (err) {
    console.error(`  ⚠️ [Playwright] Scrape failed for ${url}:`, err.message)
    if (browser) await browser.close()
    return null
  }
}

// ─── CLEARBIT / WATERFALL FALLBACK ───────────────────────────────────────────
async function fallbackEnrich(companyName) {
  try {
    const cleanName = companyName
      .toLowerCase()
      .replace(/\b(private|pvt|ltd|limited|inc|llc|llp|corp|corporation|technologies|technology|solutions|services|group|holdings|international)\b\.?/gi, '')
      .replace(/[^a-z0-9]/g, '')
      .trim()

    if (!cleanName) return null

    const guessedDomain = `${cleanName}.com`
    let logo_url = `https://logo.clearbit.com/${guessedDomain}`
    let website = `https://${guessedDomain}`

    const res = await fetch(`https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(companyName)}`)
    if (res.ok) {
      const suggestions = await res.json()
      if (suggestions && suggestions.length > 0) {
        const best = suggestions[0]
        if (best.domain && !isAtsDomain(best.domain)) {
          logo_url = best.logo || `https://logo.clearbit.com/${best.domain}`
          website = `https://${best.domain}`
        }
      }
    }

    const validImg = await isValidImage(logo_url)
    if (!validImg) {
      const domain = new URL(website).hostname
      logo_url = `https://www.google.com/s2/favicons?sz=128&domain=${domain}`
    }

    return { logo_url, website }
  } catch (err) {
    console.error('  ⚠️ [Fallback] Enrich failed:', err.message)
    return null
  }
}

// ─── MAIN RESOLVER ───────────────────────────────────────────────────────────
export async function getCompanyMetadata(companyName, provider, urlOrToken) {
  if (!companyName) return null
  
  let url = urlOrToken
  const prov = (provider || '').toLowerCase()
  if (prov === 'greenhouse' && urlOrToken && !urlOrToken.startsWith('http')) {
    url = `https://boards.greenhouse.io/${urlOrToken}`
  } else if (prov === 'lever' && urlOrToken && !urlOrToken.startsWith('http')) {
    url = `https://jobs.lever.co/${urlOrToken}`
  } else if (prov === 'ashby' && urlOrToken && !urlOrToken.startsWith('http')) {
    url = `https://jobs.ashbyhq.com/${urlOrToken}`
  }

  let result = null

  // 1. Try Cheerio SSR first (ultra-fast for Greenhouse/Lever)
  if (url && (prov === 'greenhouse' || prov === 'lever')) {
    result = await scrapeCheerio(url, prov)
  }

  // 2. Try Playwright if SSR didn't find logo/website, or if Ashby/Workday
  if (url && (!result || !result.logo_url || !result.website)) {
    const pwResult = await scrapePlaywright(url, prov)
    if (pwResult) {
      result = {
        logo_url: pwResult.logo_url || result?.logo_url || null,
        website: pwResult.website || result?.website || null
      }
    }
  }

  // Validate the logo
  if (result?.logo_url) {
    const valid = await isValidImage(result.logo_url)
    if (!valid) {
      result.logo_url = null
    }
  }

  // 3. Last-resort fallback to Clearbit / Name resolution
  if (!result || !result.logo_url || !result.website) {
    const fbResult = await fallbackEnrich(companyName)
    if (fbResult) {
      result = {
        logo_url: result?.logo_url || fbResult.logo_url || null,
        website: result?.website || fbResult.website || null
      }
    }
  }

  return result
}
