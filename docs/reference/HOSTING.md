# Hosting — cost-effective, easy, reliable

OralScale needs two tiny things hosted (audio is **never** hosted — it lives only in Gradescope):

1. **The web app** — static files (`web/`). No backend.
2. **The Signer** — a stateless edge function (`server/worker/`) that signs tokens and checks
   the clock. Optional small database (Cloudflare D1) only for rate limiting.

Everything below fits comfortably in **free tiers** for a whole course. You do **not** need to
spend money; the cheap paid options are listed only for completeness.

## Recommendation: Cloudflare (free) ⭐
One vendor, ~10 minutes, $0.

| Piece | Cloudflare product | Free tier | Notes |
|-------|--------------------|-----------|-------|
| Web app | **Pages** | unlimited static requests | drag-and-drop or `git` deploy |
| Signer | **Workers** | 100,000 requests/day | HMAC via Web Crypto; global; absorbs DoS at the edge |
| Rate-limit + cooldown DB | **D1** (SQLite) | 5 GB, 100k writes/day | **required** if `retakeCooldownSec` > 0 (INV-SEC-7); without it the cooldown silently does nothing |

Load math: one attempt = 3 signed requests (`/reveal`, `/closing`, `/finish`), each with one small
D1 write. A 300-student class doing 5 attempts each ≈ 4,500 requests **for the week** — about
**0.06%** of a single day's free allowance. You will not hit a paid tier.

Check `GET /health` after deploying: it reports `"cooldownEnforced"`, which is `false` if you
configured a cooldown but never bound D1.

Deploy is in [server/worker/README.md](../../server/worker/README.md): `wrangler deploy` for the
Signer, upload `web/` to Pages, done.

## Alternatives (all have usable free tiers)
| Option | Good for | Watch-outs |
|--------|----------|-----------|
| **Deno Deploy** | Signer (Web-standard APIs) | small code tweak to the Worker entry |
| **Vercel / Netlify** | web app + a serverless function | Hobby tier is non-commercial — fine for a course, check terms |
| **AWS Lambda + Function URL** | Signer | 1M req/month free forever; more setup |
| **Google Cloud Run** | Signer (container) | 2M req/month free; more moving parts |
| **GitHub Pages** | web app only | static only (pair with a Signer elsewhere) |

## If you'd rather pay for an always-on box (not needed)
- **Oracle Cloud "Always Free"** — a small VM **free forever**; run the Node Signer
  (`server/signer.js`) on it. In-house feel, no per-request limits.
- A **$5/month** VPS (DigitalOcean/Linode/Hetzner) ≈ **$60/year**. Simple, but more maintenance
  than serverless and more than you need.

## Purdue-hosted options
- **RCAC** compute (Anvil/Gilbreth) is HPC, not web hosting — not a natural fit for a always-on
  endpoint. If you want it fully in-house, ask **ECE IT or RCAC for a small VM/container** and run
  the Node Signer there. Heavier to maintain than the free Worker.
- **FERPA note:** you do **not** need Purdue hosting for privacy. The Signer only ever sees a
  student id, a question id, timestamps, and a SHA-256 hash — **no audio, no grades**. You can even
  pass a pseudonymous id instead of the email. Audio and grades live only in Gradescope.

## Reliability
- Cloudflare Workers run in 300+ locations with automatic failover; effectively no ops for you.
- The Signer is **stateless**, so there is nothing to back up or corrupt. If it restarts, in-flight
  students simply retake (fresh question). The D1 rate-limiter is best-effort and never blocks a
  legitimate attempt if it's unavailable.

## Bottom line
Use **Cloudflare Pages + Workers (free)**. Budget **$0/year**. Revisit paid options only if you
deliberately want an always-on in-house VM.
