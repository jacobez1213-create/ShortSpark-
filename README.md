# ShortSpark v1.2 — Accounts + persistent usage tracking

This build adds real user accounts backed by Postgres, persistent usage limits, and Stripe subscription-to-account linking.

## What it fixes
- A free user gets 1 AI video generation per UTC day.
- Usage is recorded in Postgres before generation starts, so clearing cookies won't reset the limit.
- Users sign up/login with email + password.
- Stripe Checkout requires a signed-in user and ties the subscription to that account.
- Stripe subscription webhooks update the user's plan automatically.
- Account page shows plan and remaining usage.
- Creator default: 15 videos/month.
- Pro default: 30 videos/month.
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
