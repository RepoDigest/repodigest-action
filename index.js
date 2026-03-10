// RepoDigest GitHub Action
// Fetches recent commits, PRs, and issues from the repository, then
// calls the RepoDigest API to generate an AI summary and email it to recipients.
// Requires: GITHUB_TOKEN env var (provided automatically by GitHub Actions)

async function run() {
  const apiKey = process.env['INPUT_API_KEY']
  const recipients = process.env['INPUT_RECIPIENTS']
  const lookbackDays = parseInt(process.env['INPUT_LOOKBACK_DAYS'] || '7', 10)
  const apiUrl = (process.env['INPUT_API_URL'] || 'https://www.repodigest.com').replace(/\/$/, '')

  if (!apiKey) {
    console.error('::error::api_key input is required')
    process.exit(1)
  }
  if (!recipients) {
    console.error('::error::recipients input is required')
    process.exit(1)
  }

  const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/')
  if (!owner || !repo) {
    console.error('::error::Could not determine repository from GITHUB_REPOSITORY')
    process.exit(1)
  }

  const token = process.env.GITHUB_TOKEN
  if (!token) {
    console.error('::error::GITHUB_TOKEN is not available. Make sure permissions: contents: read is set.')
    process.exit(1)
  }

  const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000).toISOString()
  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  console.log(`Fetching last ${lookbackDays} days of activity for ${owner}/${repo}...`)

  const [commitsRes, prsRes, issuesRes] = await Promise.all([
    fetch(`https://api.github.com/repos/${owner}/${repo}/commits?since=${since}&per_page=100`, { headers: ghHeaders }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=50`, { headers: ghHeaders }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/issues?state=closed&since=${since}&per_page=50`, { headers: ghHeaders }),
  ])

  if (!commitsRes.ok) {
    console.error(`::error::GitHub API error fetching commits: ${commitsRes.status} ${commitsRes.statusText}`)
    process.exit(1)
  }
  if (!prsRes.ok) {
    console.error(`::error::GitHub API error fetching pull requests: ${prsRes.status} ${prsRes.statusText}`)
    process.exit(1)
  }

  const [commitsData, prsData, issuesData] = await Promise.all([
    commitsRes.json(),
    prsRes.json(),
    issuesRes.ok ? issuesRes.json() : Promise.resolve([]),
  ])

  const sinceDate = new Date(since)

  const commits = (Array.isArray(commitsData) ? commitsData : []).map(c => ({
    sha: c.sha,
    commit: {
      message: c.commit?.message || '',
      author: {
        name: c.commit?.author?.name || '',
        date: c.commit?.author?.date || '',
      },
    },
  }))

  const prs = (Array.isArray(prsData) ? prsData : [])
    .filter(pr => pr.merged_at && new Date(pr.merged_at) >= sinceDate)
    .map(pr => ({
      number: pr.number,
      title: pr.title,
      body: pr.body || null,
      merged_at: pr.merged_at,
      user: { login: pr.user?.login || '' },
      labels: (pr.labels || []).map(l => ({ name: l.name })),
    }))

  // GitHub issues endpoint also returns PRs — filter those out
  const issues = (Array.isArray(issuesData) ? issuesData : [])
    .filter(i => !i.pull_request)
    .map(i => ({
      number: i.number,
      title: i.title,
      closed_at: i.closed_at,
      user: { login: i.user?.login || '' },
      labels: (i.labels || []).map(l => ({ name: l.name })),
    }))

  console.log(`Found ${commits.length} commits, ${prs.length} merged PRs, ${issues.length} closed issues.`)

  if (commits.length === 0 && prs.length === 0) {
    console.log('::notice::No activity found in the specified period. Skipping report.')
    process.exit(0)
  }

  console.log(`Sending to RepoDigest API at ${apiUrl}...`)

  const response = await fetch(`${apiUrl}/api/action/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      repo_owner: owner,
      repo_name: repo,
      recipients: recipients.split(',').map(r => r.trim()).filter(Boolean),
      commits,
      prs,
      issues,
      lookback_days: lookbackDays,
    }),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    console.error(`::error::${err.error || `RepoDigest API error: ${response.status}`}`)
    process.exit(1)
  }

  const result = await response.json()
  console.log(`::notice::✅ Report "${result.title}" generated and sent to ${result.recipients_count} recipient(s).`)
}

run().catch(err => {
  console.error(`::error::${err.message}`)
  process.exit(1)
})
