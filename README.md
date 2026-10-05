# ShortSpark business site + developer dashboard

This package turns the earlier landing page into a small SaaS starter with a private developer dashboard and Stripe payment/payout plumbing.

## Included

- Public ShortSpark landing page and Short generator
- Creator ($9.99/mo) and Pro ($19.99/mo) checkout buttons
- Private `/admin` developer dashboard
- Available and pending Stripe balance
- 30-day paid revenue
- Active subscription count
- Recent payments
- Recent payouts
- Admin-triggered manual payout endpoint
- Stripe webhook endpoint
- Demo dashboard when Stripe keys are not configured

## Important security note

The Stripe secret key is server-side only. Do not put it into `index.html`, `admin.html`, GitHub, or client-side JavaScript.

The included admin login is a lightweight starter authentication layer. For a real public SaaS, put this behind a stronger auth system (for example an established identity provider), use HTTPS, rotate secrets, and store application data in a database.

## Connect real payments

1. Create a Stripe account and activate your business/payout details.
2. In Stripe, create two recurring Prices matching $9.99/month and $19.99/month.
3. Copy the two price IDs into `.env`.
4. Copy your Stripe secret key into `STRIPE_SECRET_KEY`.
5. Create a webhook endpoint pointing at `/api/webhook` and copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
6. Set a strong `ADMIN_PASSWORD` and `COOKIE_SECRET`.
7. Run:

   npm install
   npm start

8. Open `http://localhost:4242` for the public site and `http://localhost:4242/admin` for the developer dashboard.

Use Stripe test mode first. Test-mode payments/payouts do not move real money.

## Receiving money

Customer subscription payments land in your Stripe balance. You connect your bank account/debit card in Stripe and use Stripe's payout schedule or the manual payout function included here. The dashboard's payout button calls Stripe's payout API using the server-side secret key.

## Production

Deploy the Node server to a HTTPS Node-compatible host and set the environment variables there. Point your Stripe webhook at the deployed HTTPS URL. Set the public site URL in any additional success/cancel or custom-domain configuration you add.

## Data

For a production SaaS, add a database and persist customer/user/subscription records from webhook events. The current dashboard reads live Stripe objects directly so it is useful as a starter, but it is intentionally not a full accounting system.

## Stripe sources

Stripe Checkout sessions can be created on the server for subscriptions; successful sessions reference the customer/subscription. Stripe payouts send funds from your Stripe balance to your default external account, and test-mode payouts do not move real funds.
