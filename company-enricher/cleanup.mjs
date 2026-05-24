/**
 * company-enricher/cleanup.mjs — Purge Empty Companies
 *
 * Runs the database utility to delete all companies that currently
 * have 0 jobs linked to them in Supabase.
 *
 * Run: node --env-file=.env company-enricher/cleanup.mjs
 */

import { deleteEmptyCompanies } from '../shared/supabase.mjs'

async function main() {
  console.log('🚀 Starting company database cleanup...')
  await deleteEmptyCompanies()
  console.log('✅ Done!')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
