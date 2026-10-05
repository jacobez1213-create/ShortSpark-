# ShortSpark security checklist

Before live launch:

- Keep `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `REPLICATE_API_TOKEN`, and `DATABASE_URL` only in Render Environment Variables.
- Never commit `.env` to GitHub.
- Use a long unique `ADMIN_PASSWORD` and `COOKIE_SECRET`.
- Set `NODE_ENV=production` on Render so session cookies get the `Secure` attribute.
- Set `PUBLIC_ORIGIN` to the exact HTTPS site origin when using a custom domain.
- Keep Stripe in test mode until Checkout + webhook + plan updates have been tested end-to-end.
- Create new Stripe Prices for the new $8.99 Creator and $15.99 Pro prices, then update the two Price ID environment variables.
- Before launch, add email verification/password reset and consider moving admin auth to an established identity provider.
