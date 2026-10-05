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

## Scene continuity update

Paid 30-second videos are generated sequentially. Scene 2 starts from a still frame extracted from the end of Scene 1, and Scene 3 starts from a still frame extracted from the end of Scene 2. The prompts also include a shared continuity bible and explicit scene beats so the three clips tell one continuous story rather than three unrelated shots.

The current Seedance 1.5 Pro API supports an `image` input for image-to-video generation, and the documented schema also supports `last_frame_image`. This build uses the simpler chained `image` approach for continuation between clips. See: https://replicate.com/bytedance/seedance-1.5-pro/api/schema
