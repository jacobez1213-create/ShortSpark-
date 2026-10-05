# ShortSpark FINAL v1.5

This is a deployment-friendly flattened version of ShortSpark. All website files are in the GitHub repository root so Render does not require a `public/` directory.

Plan limits:
- Free: 1 video/day
- Creator: $8.99/month, 10 videos/month
- Pro: $15.99/month, 24 videos/month

AI video generation, persistent Postgres usage tracking, account sessions, Stripe billing/webhooks, server-side ownership checks, rate limits, Helmet security headers, same-origin protection and PBKDF2 password hashing are included.

## Deploy
Use:
- Build command: `npm install`
- Start command: `npm start`
- Root directory: blank

Required Render variables include the existing Stripe/Replicate variables plus `DATABASE_URL`.
