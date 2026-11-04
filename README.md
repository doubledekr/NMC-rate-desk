# NMC Rate Desk

A small desktop app for the rate desk. It publishes VA Streamline par rates by credit tier to this repo
(`rates/rates.json` + `rates/history.json`); every NMC Toolkit reads them and alerts bankers whose saved clients
just became eligible.

- **Install:** download the latest release (Windows `.exe` / Mac `.dmg`). The app updates itself from this page.
- **First run:** Settings → paste the publishing key (a GitHub fine-grained token scoped to this repo, *Contents: read and write*). It is stored encrypted on that computer and survives updates.
- **Publish:** fill the four tiers (640+, 620–639, 580–619, below 580), add an optional note, Publish. Each publish is a commit here (the audit trail), then an instant ping goes out so toolkits update at once; they also poll every two minutes as a fallback.

`rates/rates.json` is public and read without any login. Pushes to `rates/**` never trigger a build.

## Look and feel

The app uses the shared NMC theme (`app/theme/nmc-theme.css` + `app/theme/nmc-motion.js`, copied from the
toolkit repo's `banker-toolkit/theme/`) with a small Rate Desk overlay in `app/theme/rate-desk.css`.
Change the shared files in the toolkit repo first, then copy them here so both apps stay in step.

**Market panel (v1.3):** the 10-year Treasury (daily close from the U.S. Treasury, FRED as backup), a "lean" that describes
the recent trend (not a forecast), rate-relevant headlines from the Fed and MarketWatch tagged Better / Worse / Neutral by
keyword rules, upcoming jobs/CPI/Fed dates, a one-click morning recap for the publish note, and a last-publish timer with a
weekday streak. All of it stays on the rate desk — nothing new is published to the toolkits, so CONTRACT.md is unchanged.
