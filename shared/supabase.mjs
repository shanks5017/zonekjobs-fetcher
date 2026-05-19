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
    'breezy.hr'
  ]

  if (company.website) {
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
    // Strip subdomains if present (e.g. jobs.meesho.com -> meesho.com)
    const parts = resolvedDomain.split('.')
    if (parts.length > 2) {
      resolvedDomain = parts.slice(-2).join('.')
    }
    
    // Primary: Clearbit premium logo, fallback handled gracefully by frontend onError
    logo_url = `https://logo.clearbit.com/${resolvedDomain.toLowerCase()}?size=128`
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
