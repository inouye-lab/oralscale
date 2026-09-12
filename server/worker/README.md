# Deploy the Signer as a Cloudflare Worker (free)

The Worker is the whole backend: three endpoints, logically stateless, and it **never receives
audio** — only hashes and timings. Cloudflare's free tier is 100,000 requests/day, far more than
any course needs.

| Endpoint | When | Cost |
|----------|------|------|
| `POST /reveal` | student taps Start | 1 per attempt (+1 D1 write) |
| `POST /closing` | student taps "I'm done" | 1 per attempt (+1 D1 write) |
| `POST /finish` | recording stops | 1 per attempt (+1 D1 write) |

Three requests per attempt. A 300-student class doing 5 attempts each is ~4,500 requests **for the
whole week** — about 0.06% of one day's free allowance.

> ### ⚠️ D1 is required if you use the retake cooldown
> `retakeCooldownSec` (INV-SEC-7, on by default) needs somewhere to remember that a student opened
> a question. The Worker has no memory of its own, so **without a D1 binding the cooldown silently
> does nothing** and students can reroll questions freely.
> `GET /health` tells you the truth: look for `"cooldownEnforced": true`.

---

## One-time setup (~10 minutes)

**1. Bundle your course into the Worker.** Workers cannot read the filesystem, so the course config
and its question banks are compiled in:

```bash
node tools/build-worker.js courses/<id>/course.json
```

That writes `server/worker/bundle.json`. Re-run it whenever a bank or `course.json` changes.

**2. Log in and create the database:**

```bash
cd server/worker
npx wrangler login
npx wrangler d1 create oralscale
```

Paste the printed `database_id` into `wrangler.toml` and uncomment the `[[d1_databases]]` block.

**3. Create the tables:**

```bash
npx wrangler d1 execute oralscale --remote --file schema.sql
```
Re-run that same command after upgrading to v6: `schema.sql` now also creates `access_log`, which
backs the access-attempt log and the failed-key lockout (INV-SEC-9). It is `CREATE TABLE IF NOT
EXISTS`, so re-running is safe. Without it the AccessKey **gate still works** — it is pure crypto —
but failed attempts are not recorded and the lockout does not fire; `GET /health` says so.

**4. Set the signing secret** (never goes in any file):

```bash
node tools/make-config.js --print     # or reuse the secret you already have
npx wrangler secret put ORALSCALE_SECRET
```

The **same** secret must go into the autograder's `source/secret.env`, or certificates will not
verify and every submission scores 0.

**5. Deploy:**

```bash
npx wrangler deploy
```

It prints `https://oralscale-signer.<you>.workers.dev`.

**6. Verify before you trust it:**

```bash
curl https://oralscale-signer.<you>.workers.dev/health
```

Expected:

```json
{"ok":true,"courseId":"example-fall2026","assignments":["week-01-…", …],
 "db":true,"cooldownEnforced":true}
```

If `cooldownEnforced` is `false`, step 2 or 3 did not take effect.

---

## Deploying the web app (Cloudflare Pages)

```bash
npx wrangler pages deploy web/ --project-name oralscale
```

Then point the app at your Worker. Either edit `web/js/config.js`:

```js
export const SIGNER_URL = 'https://oralscale-signer.<you>.workers.dev';
```

…or append `?signer=…` to the quiz link for a one-off test.

Finally, set `ALLOW_ORIGIN` in `wrangler.toml` to your Pages origin (not `*`) and redeploy.

---

## Generating the student link

```bash
node tools/gen-url.js --assignment week-04-methods-core
```

Paste that single link into the Gradescope assignment description. It is public and carries no
identity, so it is safe to publish (decision B1). The course, web app URL and Signer URL all come
from `course.json`, which `npm run deploy` fills in — there is nothing to pass by hand.

---

## Updating a bank mid-term

```bash
node tools/build-worker.js courses/<id>/course.json
cd server/worker && npx wrangler deploy
```

The signing secret is unchanged, so certificates issued earlier still verify.

## Notes
- Protocol-identical to `server/signer.js`; use the Node one for local dev. `t_signer_parity`
  in the unit suite fails if the two ever drift on token version or routes.
- `TAIL_LIMIT_SEC` (default 45) is the window between the closing code and `/finish`.
- Losing D1 degrades the retake cooldown and rate limiting — **not** integrity. Certificates,
  liveness codes and identity checks are all pure crypto and keep working.
