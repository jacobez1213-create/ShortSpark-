# ShortSpark Security Notes

- Secrets belong only in Render environment variables.
- Owner Pro code is checked server-side and is tied to OWNER_EMAIL.
- Complimentary Pro is stored in Postgres and is not controlled by browser JavaScript.
- Usage limits are enforced inside a Postgres transaction with a per-user advisory lock.
- Video status and downloads require an authenticated owner match.
- Admin endpoints require the admin session and are rate limited.
- Stripe webhook signatures are verified before subscription changes.
- Passwords are hashed with PBKDF2-SHA256.
- This is an MVP security baseline; add an established identity provider, email verification, password reset, CSRF tokens, durable job storage, and audit logging before a high-value commercial deployment.

- Paid video duration is validated on the server against the authenticated user's effective plan; editing the browser cannot unlock 5–30s for free users.
- Requested duration is stored in Postgres with each generation for auditing.
