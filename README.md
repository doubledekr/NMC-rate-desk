# NMC Rate Desk

A small desktop app for the rate desk. It publishes VA Streamline par rates by credit tier to this repo
(`rates/rates.json` + `rates/history.json`); every NMC Toolkit reads them and alerts bankers whose saved clients
just became eligible.

- **Install:** download the latest release (Windows `.exe` / Mac `.dmg`). The app updates itself from this page.
- **First run:** Settings → paste the publishing key (a GitHub fine-grained token scoped to this repo, *Contents: read and write*). It is stored encrypted on that computer and survives updates.
- **Publish:** fill the seven tiers, add an optional note, Publish. Each publish is a commit here (the audit trail), then an instant ping goes out so toolkits update at once; they also poll every two minutes as a fallback.

`rates/rates.json` is public and read without any login. Pushes to `rates/**` never trigger a build.
