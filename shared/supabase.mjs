import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_SERVICE_KEY

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY')
}

export const supabase = createClient(supabaseUrl, supabaseKey)

// ─── UPSERT COMPANY ────────────────────────────────────────────────────────────
export async function upsertCompany(company) {
  const slug = (company.slug || company.name)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')

  let logo_url = null
  let resolvedDomain = null

  const ATS_DOMAINS = [
    'greenhouse.io',
    'lever.co',
    'ashbyhq.com',
    'myworkdayjobs.com',
    'workdayjobs',
    'workday.com',
    'smartrecruiters.com',
    'recruitee.com',
    'bamboohr.com',
    'breezy.hr',
    'avature.net',
    'eightfold.ai',
    'gem.com',
    'icims.com',
    'applytojob.com',
    'join.com',
    'personio.de',
    'personio.com',
    'personio.co.uk',
    'rippling.com',
    'recruiterbox.com',
    'jobs2web.com',
    'taleo.net',
    'teamtailor.com',
    'workable.com',
    'cornerstoneondemand.com',
    'jobvite.com'
  ]

  const DOMAIN_OVERRIDES = {
    // Government / Defense
    'upsc': 'upsc.gov.in',
    'indian army': 'indianarmy.nic.in',
    'indian navy': 'indiannavy.nic.in',
    'iaf': 'indianairforce.nic.in',
    'ssb': 'ssb.gov.in',
    'drdo': 'drdo.gov.in',
    'isro': 'isro.gov.in',
    'bro': 'bro.gov.in',
    'assam rifles': 'assamrifles.gov.in',

    // Infrastructure & Transport
    'rvnl': 'rvnl.org',
    'dmrc': 'delhimetrorail.com',
    'irctc': 'irctc.co.in',
    'gmrcl': 'gujaratmetrorail.com',
    'gmrc': 'gujaratmetrorail.com',
    'rrc secr': 'secr.indianrailways.gov.in',
    'secr': 'secr.indianrailways.gov.in',
    'konkan railway': 'konkanrailway.com',
    'krcl': 'konkanrailway.com',
    'railtel': 'railtelindia.com',
    'rites': 'rites.com',
    'kmrl': 'kochimetro.org',
    'mpmrcl': 'mpmetrorail.com',
    'rrb': 'rrcb.gov.in',
    'east coast railway': 'eastcoastrail.indianrailways.gov.in',

    // Banking & Financial Institutions
    'sbi': 'sbi.co.in',
    'state bank of india': 'sbi.co.in',
    'ibps': 'ibps.in',
    'lic': 'licindia.in',
    'rbi': 'rbi.org.in',
    'nabard': 'nabard.org',
    'sidbi': 'sidbi.in',
    'bank of baroda': 'bankofbaroda.in',
    'bank of india': 'bankofindia.co.in',
    'central bank of india': 'centralbankofindia.co.in',
    'idbi bank': 'idbibank.in',
    'punjab & sind bank': 'punjabandsindbank.co.in',
    'south indian bank': 'southindianbank.com',
    'exim bank': 'eximbankindia.in',
    'tnsc bank': 'tnscbank.com',
    'tscab': 'tscab.org',
    'tgcab': 'tgcab.org',
    'cbhfl': 'cbhfl.com',
    'rnsb': 'rnsbindia.com',

    // State / Local
    'salem': 'salem.nic.in',
    'kanchipuram': 'kanchipuram.nic.in',

    // Curated Startups / Tech
    'meesho': 'meesho.com',
    'cred': 'cred.club',
    'swiggy': 'swiggy.com',
    'paytm': 'paytm.com',
    'phonepe': 'phonepe.com',
    'razorpay': 'razorpay.com',
    'groww': 'groww.in'
  }

  const cleanCompanyName = (company.name || '').toLowerCase().trim()
  let hasOverride = false
  for (const [key, val] of Object.entries(DOMAIN_OVERRIDES)) {
    if (cleanCompanyName === key || cleanCompanyName.includes(key)) {
      resolvedDomain = val
      hasOverride = true
      break
    }
  }

  if (!hasOverride && company.website) {
    try {
      const urlStr = company.website.startsWith('http') ? company.website : `https://${company.website}`
      const url = new URL(urlStr)
      const hostname = url.hostname.replace('www.', '')
      
      // If website isn't an ATS portal, use it
      const isAts = ATS_DOMAINS.some(d => hostname.toLowerCase().includes(d))
      if (!isAts) {
        resolvedDomain = hostname
      }
    } catch (e) {
      // ignore
    }
  }

  // Fallback: If no valid domain was extracted from website, generate one from the name
  if (!resolvedDomain && company.name) {
    const cleanName = company.name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
    resolvedDomain = `${cleanName}.com`
  }

  if (resolvedDomain) {
    // For Google's Favicon API, keeping the full subdomain is better.
    // However, if we don't have an override and it was a custom website, we can use it.
    logo_url = `https://www.google.com/s2/favicons?sz=128&domain=${resolvedDomain.toLowerCase()}`
  }

  const { data, error } = await supabase
    .from('companies')
    .upsert(
      {
        name: company.name,
        slug,
        website: company.website || null,
        industry: company.industry || null,
        country: company.country || 'India',
        ats_provider: company.atsProvider,
        ats_token: company.atsToken || null,
        ats_url: company.atsUrl || null,
        logo_url,
        source: company.source,
        updated_at: new Date().toISOString()
      },
      { onConflict: 'slug', ignoreDuplicates: false }
    )
    .select('id')
    .single()

  if (error) {
    console.error(`  ✗ Company upsert failed: ${company.name} — ${error.message}`)
    return null
  }
  return data?.id
}

// ─── UPSERT JOBS (Rule 5: Update & Dedupe) ───────────────────────────────────
export async function upsertJobs(jobs) {
  if (!jobs?.length) return 0

  const validJobs = jobs.filter(
    (j) => j.external_id && j.ats_provider && j.apply_url && j.title
  )

  if (!validJobs.length) return 0

  // Rule 5: No Duplicates & Fresh Info
  // Use upsert with onConflict to update existing records
  const { error } = await supabase
    .from('jobs')
    .upsert(validJobs, {
      onConflict: 'external_id,ats_provider',
      ignoreDuplicates: false // Update existing records to refresh info and fetched_at
    })

  if (error) {
    console.error('  ✗ Jobs upsert error:', error.message)
    return 0
  }

  return validJobs.length
}

// ─── CLEANUP MISSING JOBS (Rule 6: Cleanup) ──────────────────────────────────
export async function cleanupMissingJobs(companyId, currentExternalIds) {
  if (!companyId) return

  // Rule 6: The "Stay Alive" & "Empty Company" Rules.
  // Supabase's NOT IN query string breaks for large companies (500+ jobs).
  // Strategy: fetch all existing external_ids for this company, diff locally,
  // then delete stale IDs in batches of 50 to stay well within URL limits.

  const currentSet = new Set(currentExternalIds || [])

  // Fetch all existing job IDs for this company
  const { data: existingJobs, error: fetchError } = await supabase
    .from('jobs')
    .select('id, external_id')
    .eq('company_id', companyId)

  if (fetchError) {
    console.error(`  ✗ Cleanup fetch failed for company ${companyId}:`, fetchError.message)
    return
  }

  // If no current IDs provided, delete everything (empty company rule)
  if (currentSet.size === 0) {
    const staleIds = (existingJobs || []).map(j => j.id)
    if (!staleIds.length) return
    await _deleteInBatches(companyId, staleIds)
    console.log(`  ✓ Cleaned up ${staleIds.length} jobs for emptied company ${companyId}`)
    return
  }

  // Find jobs no longer in the current fetch
  const staleIds = (existingJobs || [])
    .filter(j => !currentSet.has(j.external_id))
    .map(j => j.id)

  if (!staleIds.length) return

  await _deleteInBatches(companyId, staleIds)
  console.log(`  ✓ Cleaned up ${staleIds.length} stale jobs for company ${companyId}`)
}

async function _deleteInBatches(companyId, rowIds, batchSize = 50) {
  for (let i = 0; i < rowIds.length; i += batchSize) {
    const batch = rowIds.slice(i, i + batchSize)
    const { error } = await supabase
      .from('jobs')
      .delete()
      .in('id', batch)
    if (error) {
      console.error(`  ✗ Batch delete failed for company ${companyId}:`, error.message)
    }
  }
}

// ─── EXPIRE OLD JOBS ───────────────────────────────────────────────────────────
export async function expireOldJobs(daysOld = 30) {
  const cutoff = new Date(
    Date.now() - daysOld * 24 * 60 * 60 * 1000
  ).toISOString()

  const { error } = await supabase
    .from('jobs')
    .update({ is_active: false })
    .lt('fetched_at', cutoff)
    .eq('is_active', true)

  if (error) {
    console.error('  ✗ Expire jobs error:', error.message)
  } else {
    console.log(`  ✓ Expired jobs older than ${daysOld} days`)
  }
}

// ─── LOG RUN ───────────────────────────────────────────────────────────────────
export async function logRun(source, jobsCount, status) {
  console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Source  : ${source}
  Jobs    : ${jobsCount}
  Status  : ${status}
  Time    : ${new Date().toISOString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `)
}
