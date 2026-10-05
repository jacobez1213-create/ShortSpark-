# ShortSpark v1.2 — Accounts + persistent usage tracking

This build adds real user accounts backed by Postgres, persistent usage limits, and Stripe subscription-to-account linking.

## What it fixes
- A free user gets 1 AI video generation per UTC day.
- Usage is recorded in Postgres before generation starts, so clearing cookies won't reset the limit.
- Users sign up/login with email + password.
- Stripe Checkout requires a signed-in user and ties the subscription to that account.
- Stripe subscription webhooks update the user's plan automatically.
- Account page shows plan and remaining usage.
- Creator default: 10 videos/month.
- Pro default: 24 videos/month.
- Limits can be changed with environment variables.

## Database
Use Neon Postgres for the persistent database. As of Oct. 2, 2026, Neon advertises 1 GB of Postgres storage per Free project. For a real production business, monitor usage and upgrade when needed.

Create a Neon project, copy the pooled connection string, and add it to Render as:

DATABASE_URL=postgres://...?...sslmode=require

The app automatically creates its tables when it starts.

## Render settings
Keep:
- Runtime: Node
- Build command: npm install
- Start command: npm start
- Root directory: blank

Add DATABASE_URL to the existing Render Environment Variables. Keep your Stripe and Replicate secrets there too. Never upload .env to GitHub.

## AI video
Keep REPLICATE_API_TOKEN in Render. The current AI video generator uses Seedance 1.5 Pro via Replicate and combines three 10-second clips with ffmpeg.

## Security status
Passwords are hashed with Node scrypt. Session tokens are stored hashed in Postgres and sent as HttpOnly/SameSite cookies. Stripe and Replicate credentials stay server-side.

For a broad public launch, add email verification, password reset, CSRF/origin protections, durable video object storage, job queues, and stronger admin authentication.

## Sources
Neon Free plan (Oct. 2, 2026): https://neon.com/blog/neon-free-plan-1-gb-per-project
Neon Postgres connection strings: https://neon.com/blog/authenticating-users-in-astro-using-neon-postgres-and-lucia-auth
Render free services and ephemeral storage: https://render.com/docs/free


## Signup fix

This build also fixes account creation on small Render instances by adjusting the Node `scrypt` memory settings so password hashing does not exceed Node's default memory limit.


## Signup error fix
The account-password hashing implementation now uses Node PBKDF2-SHA256 instead of memory-heavy scrypt, which avoids `ERR_CRYPTO_INVALID_SCRYPT_PARAMS` on small/free Render instances.


## Budget mode
This build uses Seedance 1.5 Pro at 480p without model-generated audio, then adds separate narration. Current listed Seedance cost is $0.013/s without audio at 480p. The TTS model defaults to Inworld realtime-tts-1.5-mini, currently listed at $0.015 per 1,000 input characters. Together, typical 30-second narration should leave meaningful margin under a $0.50 raw AI-usage target, but actual spend can vary with retries and output length.


## Current business plans
- Free: 1 video per day
- Creator: $8.99/month, 10 videos/month
- Pro: $15.99/month, 24 videos/month

The website text and server defaults now match those limits. Because Stripe Price objects are separate resources, create new $8.99 and $15.99 monthly Prices (test mode first), then update `STRIPE_PRICE_CREATOR` and `STRIPE_PRICE_PRO` in Render to the new `price_...` IDs. Stripe documents creating recurring Prices for a Product and using the Price ID in Checkout. 

## Security hardening in v1.3
- Helmet security headers (CSP remains disabled because the current pages contain inline scripts; moving scripts to external files is a future CSP hardening step).
- Server-side Postgres usage enforcement with transactional row locking/advisory locking.
- Server-side authentication for video generation, account usage, and Stripe checkout.
- HttpOnly + SameSite session cookies with `Secure` in production.
- Hashed session tokens in Postgres.
- PBKDF2-SHA256 password hashing with timing-safe verification.
- Request body size limit.
- Same-origin checks on state-changing browser requests.
- Rate limits on signup, login, checkout, admin login, logout, and video generation.
- Stripe webhook signature verification.
- Generated videos and caption files require the authenticated owner session.
- Stripe checkout uses an idempotency key.
- Admin and secret credentials remain server-side in Render environment variables.

## Important production note
This is a strong MVP foundation, not a formal security certification. Before a larger launch, add email verification, password reset, a durable job queue, object storage for generated videos, centralized rate limiting if you scale to multiple instances, stronger admin identity/authentication, monitoring/alerting, and a CSP after moving inline scripts into external assets.


## Final v1.3 file layout
Only browser-facing files live under `public/`. The Node server, package manifest, README, and environment template are outside the public directory so Express static hosting does not expose your server source or deployment files.

Upload the contents of this package to the root of your GitHub `shortspark` repository. Keep the existing Render Root Directory blank and Start Command `npm start`.
