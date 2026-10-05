# ShortSpark final build

## Plans
- Free: 1 video per UTC day, 10-second output, 360p delivery.
- Creator: $8.99/month, 10 videos/month, 30-second output, 480p delivery.
- Pro: $15.99/month, 24 videos/month, 30-second output, 480p delivery.

## Cost-saving video setup
Seedance 1.5 Pro currently supports 480p as its lowest listed resolution and bills by output second. Current Replicate pricing lists 480p without model-generated audio at $0.013/second. The free tier therefore generates only one 10-second 480p clip upstream and then transcodes the delivered file to 360p. Paid tiers generate three 10-second 480p clips and combine them into a 30-second 480p Short. A separate TTS pass provides narration.

Important: the free 360p delivery reduces the final file resolution, but the video model still runs at its 480p minimum, so the AI provider cost is driven by 10 seconds of 480p generation, not 360p.

## Accounts + usage security
- Postgres-backed accounts and usage records.
- Free daily and paid monthly limits enforced server-side.
- Transactional reservation with row/advisory locking prevents concurrent double-spend of a quota.
- Session tokens stored hashed in Postgres.
- HttpOnly + SameSite cookies, Secure in production.
- PBKDF2-SHA256 passwords with timing-safe verification.
- Same-origin checks on state-changing requests.
- Rate limits on auth, checkout, admin, and video endpoints.
- Stripe webhook signature verification and subscription-to-account linking.
- Video status/download routes verify the authenticated owner.
- Helmet security headers and disabled x-powered-by.
- Secrets remain in Render environment variables, never GitHub.

## Render
Build command: `npm install`
Start command: `npm start`
Root directory: blank

Existing required environment variables:
- ADMIN_PASSWORD
- COOKIE_SECRET
- DATABASE_URL
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- STRIPE_PRICE_CREATOR
- STRIPE_PRICE_PRO
- REPLICATE_API_TOKEN

Optional:
- PUBLIC_ORIGIN
- VIDEO_MODEL (default `bytedance/seedance-1.5-pro`)
- TTS_MODEL (default `inworld/realtime-tts-1.5-mini`)
- TTS_VOICE_ID (default `Ashley`)
- FREE_VIDEOS_PER_DAY (default 1)
- CREATOR_VIDEOS_PER_MONTH (default 10)
- PRO_VIDEOS_PER_MONTH (default 24)

Do not upload `.env` or any secret value to GitHub.

## Important production notes
The site is an MVP, not a security certification. Before a larger public launch, add email verification, password reset, a durable video job queue, persistent object storage, centralized rate limiting if running multiple instances, stronger admin identity/authentication, monitoring/alerting, and a CSP after moving inline scripts to external files.


### Free-tier video format
Free users receive one 10-second video per day. The model is run for one 10-second 480p clip and the final file is downscaled to 360p delivery. Creator and Pro generate three 10-second 480p clips and combine them into a 30-second 480p Short. This keeps the Free tier materially cheaper in output seconds while keeping paid plans at the lower-cost 480p pipeline.
