# zonekjobs-fetcher

Automated job data pipeline for [ZonekJobs](https://zonekjobs.com).

Pulls live job postings from **OpenJobs** and **OpenPostings** on alternating days and upserts them to a Supabase database with zero duplicates.

---

## Architecture

```
OpenJobs (outscal)          OpenPostings (Masterjx9)
     │                              │
  Odd Days (1,3,5...)        Even Days (2,4,6...)
  6:00 AM IST                6:00 AM IST
     │                              │
     └──────────┬───────────────────┘
                ▼
        GitHub Actions
                ▼
        Supabase DB
        (dedup: external_id + ats_provider)
                ▼
        ZonekJobs Frontend
```

## Project Structure

```
zonekjobs-fetcher/
├── .github/
│   └── workflows/
│       ├── fetch-openjobs.yml       ← Runs on odd days (1,3,5...)
│       └── fetch-openpostings.yml   ← Runs on even days (2,4,6...)
├── openjobs/
│   └── run.mjs                      ← Reads companies_v2.json, fetches India-relevant jobs
├── openpostings/
│   └── run.mjs                      ← Uses curated list of ~50 verified Indian companies
├── shared/
│   └── supabase.mjs                 ← Shared Supabase client, upsert helpers
├── package.json
├── .env.example
└── .gitignore
```

## Setup

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/zonekjobs-fetcher.git
cd zonekjobs-fetcher
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
# Fill in your Supabase credentials
```

```
SUPABASE_URL=https://yourproject.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key
```

> ⚠️ Use the **service_role** key (NOT anon key). The fetcher bypasses RLS to insert jobs.
> Find it in Supabase → Settings → API → `service_role`

### 3. Add GitHub Secrets

In your GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret Name | Value |
|---|---|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Your `service_role` key |

---

## Running Locally

```bash
# Test OpenJobs runner (requires OpenJobs cloned alongside)
git clone https://github.com/outscal/OpenJobs.git openjobs-repo
node openjobs/run.mjs

# Test OpenPostings runner
node openpostings/run.mjs
```

## Supabase Schema Requirements

The pipeline writes to two tables. Make sure they exist in your Supabase project:

### `companies`
```sql
create table companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text unique not null,
  website     text,
  industry    text,
  country     text,
  ats_provider text,
  ats_token   text,
  ats_url     text,
  source      text,
  updated_at  timestamptz default now()
);
```

### `jobs`
```sql
create table jobs (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid references companies(id),
  external_id  text not null,
  title        text not null,
  location     text,
  is_remote    boolean default false,
  apply_url    text not null,
  ats_provider text not null,
  job_type     text,
  department   text,
  posted_at    timestamptz,
  fetched_at   timestamptz default now(),
  is_active    boolean default true,
  source_repo  text,
  unique (external_id, ats_provider)
);
```

## Deduplication

Both scrapers use the composite key `(external_id, ats_provider)` with `ignoreDuplicates: true`. If OpenJobs and OpenPostings both find the same Greenhouse job, the second upsert silently skips — **zero duplicates guaranteed**.

Jobs older than 30 days are automatically marked `is_active = false`.

## Supported ATS Providers

| Provider | OpenJobs | OpenPostings |
|---|---|---|
| Greenhouse | ✅ | ✅ |
| Lever | ✅ | ✅ |
| Ashby | ✅ | ✅ |
| Workday | ✅ | ✅ |
| SmartRecruiters | ✅ | — |
| Recruitee | ✅ | — |
| BambooHR | ✅ | — |
| BreezyHR | ✅ | — |

## License

MIT
