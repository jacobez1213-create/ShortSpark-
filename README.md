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

The current Wan 2.2 5B Fast API supports an `image` input for image-to-video generation, and the documented schema also supports `last_frame_image`. This build uses the simpler chained `image` approach for continuation between clips. See: https://replicate.com/bytedance/Wan 2.2 5B Fast is the active video model for this build.5-pro/api/schema


## Developer / owner Pro access

This build includes a safer owner-only Pro entitlement. Set `OWNER_EMAIL` and `OWNER_ACCESS_CODE` in Render. The developer code only works when the signed-in account email matches `OWNER_EMAIL`; it grants complimentary Pro, not admin access. An authenticated admin can also grant/revoke complimentary Pro for a specific account from `/admin`. Complimentary Pro is preserved across Stripe subscription webhook updates until an admin revokes it.

## Plan limits

- Free: 1 video/day; 10 seconds; 360p delivery
- Creator: $8.99/month; 10 videos/month; 30 seconds; 480p
- Pro: $15.99/month; 24 videos/month; 30 seconds; 480p


## Paid duration selector (v1.8)
- Free users are forced server-side to 10 seconds.
- Creator and Pro can choose whole-second durations from 5 through 30 seconds.
- The server rejects paid duration requests outside 5–30 seconds and ignores client attempts to give free users longer durations.
- To stay compatible with Wan 2.2 5B Fast's 2–12 second per-clip limit, totals use the minimum number of connected clips: 5–12s = 1 clip, 13–24s = 2 clips, 25–30s = 3 clips. A 30s request remains 10/10/10.
- Paid scenes are generated sequentially and each later scene starts from the prior scene's extracted last frame, preserving continuity.


## Fast low-cost video engine

The app now defaults to `wan-video/wan-2.2-5b-fast` at 480p. Replicate currently lists the 480p price at $0.0125 per output video. The model accepts 81–121 frames and is designed for fast inference; Replicate's current examples show a 121-frame 480p run completing in about 5.3 seconds. For a 30-second Short, ShortSpark uses four connected clips and trims the joined result to exactly 30 seconds, so raw video-model usage is about $0.05. Narration is generated separately with Inworld Realtime TTS 1.5 Mini at $0.015 per 1,000 characters, so typical narration adds only fractions of a cent to a few cents. These are provider-model costs only; hosting, storage, retries, and payment processing are additional.

This model has no native audio output, so ShortSpark generates narration separately and muxes it into the final MP4.


## v2.0 generation engine

This build actively defaults to `wan-video/wan-2.2-5b-fast`.
Its current API supports 480p, 16:9 and 9:16, `go_fast`, image-to-video continuation, and 81–121 frames at 16 fps. The app chains the minimum number of connected shots needed for 5–30 second paid videos, then trims the assembled MP4 to the exact requested duration. See the current Replicate model page and schema for the authoritative inputs and pricing.
