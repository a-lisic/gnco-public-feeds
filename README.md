# GNCO public feeds

This repository builds the public event, message, and series files used by
goodnewsco.church. GitHub Actions reads Good News Co.'s public Church Center
organization data, mirrors each public record's associated artwork, and deploys
the generated `dist-pages/` directory to GitHub Pages.

The repository requires no Planning Center credential, API key, PAT, OAuth
secret, or repository secret. Do not add one. Generated files contain public
Church Center content only and must never be used for form submissions,
donations, passwords, or other sensitive transactions.

## Commands

```bash
npm ci
npm run typecheck
npm test

PUBLIC_BASE_URL="https://OWNER.github.io/REPOSITORY/" \
PREVIOUS_BASE_URL="https://OWNER.github.io/REPOSITORY/" \
npm run build
```

Production runs use `.github/workflows/refresh-gnco-feeds.yml`. The Pages
publishing source must be set to **GitHub Actions**, and only the default branch
may deploy to the `github-pages` environment.

The hourly schedule is not a real-time guarantee. Use **Run workflow** on the
default branch when a newly published Church Center item must appear promptly.
GitHub can automatically disable schedules in a public repository after 60 days
without repository activity, so GNCO must verify the workflow and `health.json`
at least monthly.
