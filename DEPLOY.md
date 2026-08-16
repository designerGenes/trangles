# Deploying Trangles

The app ships as one Docker image (the existing `Dockerfile`, Go binary
unchanged) running as a single Cloudflare Container instance, fronted by a
Worker that does nothing but hand every request — including the `/ws`
socket — straight to it. `git push` to `main` builds, tests, and deploys.

## Why one container instance, not several

`session.go`'s `Hub` holds every session in that process's memory, keyed by a
5-character code the client sends *inside* the first WebSocket message, not
in the connection URL. Nothing in front of the Go process — not the Worker,
not a load balancer — can see that code before the socket is already open, so
there is no way to route two people in the same room to the same instance if
there's more than one. `wrangler.jsonc` pins `max_instances: 1` for exactly
this reason. `REDIS_URL` (`cache.go`) is a restart-recovery mirror, not a
fan-out layer, and doesn't change this. Real horizontal scaling would mean
putting the session code in the `/ws` URL so the Worker can hash-route
deterministically — a real change, not a config flip, and out of scope here.

The one-instance limit is a current application constraint, not a capacity
setting to tune independently.

## One-time setup

1. **Confirm the zone exists.** Since `Trangles.com` was bought through the
   Cloudflare registrar, a zone for it already exists on your account with
   Cloudflare's nameservers — there's nothing to create.

2. **Create a scoped API token.** Cloudflare dashboard → *My Profile → API
   Tokens → Create Token → Custom → Edit Cloudflare Workers* template. This
   covers deploying the Worker and provisioning the container.

3. **Find your Account ID.** Cloudflare dashboard → any domain → Overview,
   right-hand sidebar.

4. **Add two GitHub Actions secrets** (repo → *Settings → Secrets and
   variables → Actions*):
   - `CLOUDFLARE_API_TOKEN` — the token from step 2
   - `CLOUDFLARE_ACCOUNT_ID` — the ID from step 3

5. **Install the deploy tooling** (not part of the runtime image — see
    `package.json`):
    ```
    pnpm install --frozen-lockfile
   ```

6. **First deploy.** Either push to `main` and let the workflow run, or do
   it once by hand to see it work locally (needs Docker running — `docker
   info` should succeed first):
   ```
    pnpm exec wrangler login
    pnpm deploy
   ```
   The first deploy provisions the container, the Durable Object, and —
   because of `custom_domain: true` in `wrangler.jsonc` — the DNS record and
   TLS certificate for `trangles.com`. That's the entire "connect DNS" step;
   there's no separate registrar or Terraform action to take.

## Every deploy after that

Push to `main`. The workflow runs `go test ./...` and
`pnpm test:ui`; only if both pass does it run `wrangler deploy`,
which rebuilds the image, pushes it to Cloudflare's registry, and rolls the
container. A rollout stops the old Go process, so clients must reconnect after
a deploy and an in-progress in-memory round is lost unless Redis recovery is
enabled. `sleepAfter: "30m"` keeps an otherwise idle container warm between
rounds; it does not preserve process memory across a stop or rollout.

## www.trangles.com

Not routed in `wrangler.jsonc` on purpose. A second `custom_domain` route
would serve the app live on both hostnames with no redirect between them —
fine for now, but not great for canonical links or SEO. The simpler fix is a
free, code-free **Redirect Rule** in the dashboard (*trangles.com zone →
Rules → Redirect Rules*): `www.trangles.com/*` → `https://trangles.com/$1`,
301. No deploy involved, and it survives every future `wrangler deploy`
untouched since it isn't part of this repo.

## Optional: Redis for restart recovery

`cache.go` already supports mirroring sessions to Redis so a redeploy or
crash doesn't erase an in-progress round — it's off unless `REDIS_URL` is
set. To turn it on:

```
pnpm exec wrangler secret put REDIS_URL
```

then uncomment the `envVars` block and the `cloudflare:workers` import in
`worker/index.js`. This is unrelated to the single-instance constraint above
— it's a safety net for one instance, not a way to add more.

## Rolling back

```
pnpm exec wrangler deployments list
pnpm exec wrangler rollback [deployment-id]
```
