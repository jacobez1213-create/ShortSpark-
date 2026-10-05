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


## v2.1 player fix
The player now fetches the protected MP4 as a blob, loads it into a browser object URL, waits for metadata before revealing the player, sets an explicit MP4 response type on the server, and provides an Open video fallback. The Wan 2.2 5B Fast input is also aligned with its current API schema.


## v2.2 video player fix

Completed videos are now streamed directly to the browser with HTTP Range support instead of being downloaded into a client-side Blob before playback. This lets the native video player start as soon as it has enough data and is much more reliable on Render's free instance.


## Browser/ad-blocker compatibility

ShortSpark does not load advertising scripts, tracking pixels, remote fonts, or third-party JavaScript in the customer UI. Application requests are first-party (`/api/...`). Stripe Checkout remains a necessary external service for payments and is opened as a top-level redirect; a browser extension that blocks Stripe can still prevent checkout, and this build reports that clearly rather than attempting to circumvent the user's blocker.


## v2.5 button/generation reliability

- The Generate button uses a direct event listener instead of inline HTML handlers.
- It preflights account/quota state before starting a job and reports quota/auth/network errors visibly.
- The server is hard-locked to Wan 2.2 5B Fast.
- Free 10-second generation now uses connected clips because the provider caps a single clip at 121 frames.
- `OWNER_BYPASS_LIMITS=true` lets the configured owner account test without plan-quota blocking.
- `/api/generator-status` exposes non-secret diagnostics for the signed-in user's active model, resolution, plan and quota.


## v2.6
The generator UI JavaScript is served from a dedicated `/app.js` file with `defer`, instead of an inline script. This avoids browser/CSP/extension issues that can leave the Generate button inert.


## v2.7 completion-state fix
The generator now explicitly marks in-memory jobs as `completed` when the final MP4 and captions are ready. The status endpoint also returns the output duration and dimensions. This prevents the UI from remaining on "Starting/Generating" while displaying a ready message.


## v2.9 paid prompt helper

Paid users now get an in-app prompt example and copy/use controls. The helper clearly lists paid benefits: 5–30 second duration selection, 480p delivery, fast Wan 2.2 5B generation, connected scenes, MP4 and captions downloads, and paid plan monthly allowances. The helper is hidden from free accounts.


## v3.0 script + action + expressive voice controls

The generator now accepts three explicit creative controls:
- **Script / narration:** exact words to speak; blank means ShortSpark creates the narration.
- **What is the subject/object doing?:** direct visual-action instruction used in every connected scene prompt.
- **Voice emotion:** excited, suspenseful, warm, dramatic, or calm.

The Inworld Realtime TTS 1.5 Mini model supports expressive audio markups such as `[happy]`, `[surprised]`, and `[fearful]`, plus pauses. ShortSpark maps the selected emotion into those markups and uses the `Alex` voice by default because the current model documentation describes it as energetic and expressive. 


## v3.1 checkout + AI support

- Creator and Pro pricing buttons now use delegated event handling in `billing.js`, which avoids silent failures from inline handlers and shows a visible checkout error.
- A floating **AI Support** chat is included on the home and account pages.
- AI support uses the OpenAI Responses API on the server; the OpenAI key stays in Render environment variables. If no key is configured, ShortSpark falls back to a built-in support FAQ message.
- Add `OPENAI_API_KEY` and optionally `SUPPORT_MODEL=gpt-5.5` to Render to enable AI support.


## v3.2 button reliability

Stripe plan controls are now real first-party links to `/subscribe/creator` and `/subscribe/pro`. JavaScript only enhances the experience, so the checkout buttons still work if frontend JS fails or a privacy extension blocks a script.

AI Support also has a first-party `/support` page. The floating support control opens the widget when JavaScript is available and naturally falls back to the support page if it is not.


## v3.3 Stripe + AI support connection fix

### Stripe
Creator and Pro controls now use first-party `/subscribe/creator` and `/subscribe/pro` links even if JavaScript is unavailable. The account page no longer relies on a button-only click handler. The server also reports clear setup errors when the Stripe secret key or price IDs are missing.

### AI support
The support agent uses the OpenAI Responses API with `gpt-6-luna` by default for low-cost, high-volume support. Add `OPENAI_API_KEY` to Render Environment Variables to enable the live AI agent. The key is never sent to the browser.
