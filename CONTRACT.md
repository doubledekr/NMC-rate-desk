# rates.json — the contract between the Rate Desk and the NMC Toolkit

The two apps release independently. This file is what keeps them compatible: the Rate Desk writes it, the
Toolkit reads it, and neither side changes it without following the rules at the bottom.

## Files

| Path | Written by | Read by |
| --- | --- | --- |
| `rates/rates.json` | Rate Desk, on every publish | Toolkit (poll every 2 min; instantly on a ping) |
| `rates/history.json` | Rate Desk, appended on every publish, trimmed to 90 days | Toolkit (My desk chart) |
| `rates/market.json` | Rate Desk, on every **market note** (v1.4+) | Toolkit (market-note banner) |
| `rates/market-history.json` | Rate Desk, appended on every market note, trimmed to 30 days | Toolkit (optional list of recent notes) |

## rates.json (format 2)

```json
{
  "format": 2,
  "version": "2026-11-03T20:55:26Z",
  "published": "2026-11-03T20:55:26Z",
  "by": "NMC Rate Desk",
  "note": "optional free text shown on the toolkit banner",
  "ping": { "server": "https://ntfy.sh", "topic": "nmc-rates-…" },
  "products": {
    "va_irrrl": {
      "label": "VA Streamline",
      "tiers": { "640+": 6.375, "620-639": 6.5, "580-619": 6.75, "<580": 7.0 }
    }
  }
}
```

- `format` — integer. The Toolkit knows format ≤ 2. A file with a higher number is left unread and the Toolkit tells the banker to update.
- `version` — changes on every publish; the Toolkit compares this string to decide "new rates arrived". Nothing else triggers a banner.
- `published` — ISO-8601 UTC. Used for timestamps and the "new this week" window.
- `ping` — where the Rate Desk posts a wake-up after each publish. The Toolkit subscribes to `server/topic/sse`. The ping carries no rates; the Toolkit always re-reads this file.
- `products.<key>.tiers` — rates in percent, number, by credit tier. Keys are exact strings. The Toolkit uses `va_irrrl` today; other product keys are ignored until it learns them.
- `market` *(optional, v1.4+)* — the rate desk's market read at the moment of this rate publish:
  `{ "lean": { "state": "improving|worsening|choppy|steady", "label": "Improving", "line": "10-yr down 4 of the last 5 days, −16 bps…" } | null,
     "tenYear": { "y": 4.82, "dayBps": -6, "asOf": "ISO time", "live": true } | null }`.
  Absent when the rate desk turned it off. Informational only — never used for eligibility.
- Format 2 publishes also carry the retired 7 tier names (`680+`, `660-679`, `640-659`, `600-619`, `580-599`) filled from the
  new 4, so toolkits that haven't updated keep working. A format-2 reader uses only the 4 names below and ignores the rest.
- Credit tiers (format 2): `640+`, `620-639`, `580-619`, `<580`. A client's score maps to the first tier whose range contains it; a client with no score is tested against `620-639` (a toolkit setting).

Format 1 (retired) used seven tiers. Toolkits still read it by mapping `680+` → `640+` and `600-619` → `580-619`.

## market.json (market format 1) — notes that are *not* rate changes

```json
{
  "format": 1,
  "id": "2026-11-05T13:42:10Z",
  "at": "2026-11-05T13:42:10Z",
  "by": "Kobe",
  "kind": "move",
  "title": "10-yr move",
  "text": "10-yr down 6 bps to 4.82% since yesterday's close. Rates unchanged for now — could improve if this holds.",
  "comment": "Hold locks until after the jobs report.",
  "tenYear": { "y": 4.82, "bps": -6, "since": "close" },
  "lean": { "state": "improving", "label": "Improving", "line": "…" },
  "ping": { "server": "https://ntfy.sh", "topic": "nmc-rates-…" }
}
```

- `kind` — `move` (10-yr moved past the alert threshold), `lean` (market lean), `brief-morning`, `brief-midday`, `brief-eod`,
  `broadcast` (a message the rate desk wrote from scratch).
- `comment` *(optional, v1.5+)* — the rate desk's own note added to the message, at most 200 characters. Show it under `text`,
  set apart (e.g. quoted, with `by`). Absent when there is none.
  Unknown kinds are shown like any other note.
- `id` changes on every note; the Toolkit compares it to decide "new market note arrived".
- `text` — plain text, at most 280 characters. Show it as written.
- A market note **never** changes rates, eligibility, the "now eligible" list or the rate banner. It is a separate, lighter banner.
- Every note is approved by a person on the rate desk before it is sent.
- Ping: the same topic as rates; the body is `{"kind":"market","id":"…"}` for a market note and `{"kind":"rates","version":"…"}` for
  a rate publish. On `market`, re-read `market.json`; on `rates`, re-read `rates.json`. Poll both files as a fallback.

## history.json

A JSON array, newest first, each entry the same object as rates.json (without `ping`). Trimmed to 90 days.

## Rules for changing this

1. **Adding** a field, a product key or metadata: no format bump. Toolkits ignore what they don't know.
2. **Renaming or removing** a field, or changing tier names: bump `format`. Ship the Toolkit that reads the new format *first*, wait until bankers have updated (the Toolkit auto-updates within minutes), then ship the Rate Desk that writes it. The Toolkit must keep reading the previous format for at least one release.
3. Never change the meaning of an existing field without a bump.
4. A Rate Desk update that doesn't touch this file can ship any time; a Toolkit update that doesn't touch its reader can ship any time.
