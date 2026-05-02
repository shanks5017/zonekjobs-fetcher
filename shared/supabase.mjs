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

// ─── UPSERT JOBS (deduplicated by external_id + ats_provider) ─────────────────
export async function upsertJobs(jobs) {
  if (!jobs?.length) return 0

  const validJobs = jobs.filter(
    (j) => j.external_id && j.ats_provider && j.apply_url && j.title
  )

  if (!validJobs.length) return 0

  const { error } = await supabase
    .from('jobs')
    .upsert(validJobs, {
      onConflict: 'external_id,ats_provider',
      ignoreDuplicates: true // silently skip if already exists — zero duplicates
    })

  if (error) {
    console.error('  ✗ Jobs upsert error:', error.message)
    return 0
  }

  return validJobs.length
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
