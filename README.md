# Xquery.io backend

The API behind [xquery.io](https://xquery.io): accounts, license keys for the Xquery desktop app, team seat
management, the staff console, and the product service the app reads (`/v1/manifest`, `/v1/ping`).

TypeScript on Node 22 with Fastify, MongoDB (Atlas in production) through the official driver, zod validation.
Every endpoint is listed in [docs/API.md](docs/API.md); `GET /openapi.json` serves the same as OpenAPI.

## How licensing works

The app verifies keys offline: a key is `XQ1.<payload>.<Ed25519 signature>` and the app embeds the public key.
This service holds the private key and signs one key per person:

- **Free plan.** When a user confirms their e-mail they get a key, e-mailed and shown on `/account`. Today that is a
  1-year Pro key for everyone. Whether it is free, how long it lasts and which edition it gives are staff settings
  (`PUT /admin/plans/free`), so charging later needs no code change. Changes apply to keys issued afterwards.
- **Teams.** A team has a seat limit (free for now; staff raise it). Admins invite people; a seat issues that person
  their own key with the team as customer. Removing someone frees the seat and revokes their key.
- **Revocation.** Revoked keys are listed by hash in the signed manifest the app fetches every 4 hours
  (`includeRevocations`, off until the app release that reads it ships).

`src/licensing/licenseFormat.ts` and `manifest.ts` are copied from the app repo so both sides use the same signing
code. Keep them in sync when the app changes.

## Run it locally

```sh
npm install
npm run keygen:dev            # writes .license-dev/xquery-license-private.pem (gitignored)
cp .env.example .env          # points at that key and a local MongoDB
npm run dev                   # http://localhost:4000, e-mails are printed to the log
npm run make-staff -- you@example.com   # after registering, for /admin
```

To issue keys a development build of the app accepts, either set `LICENSE_SIGNING_KEY_FILE` to the app's own
`.license-dev/xquery-license-private.pem`, or put the public key this server logs at start-up into the app's
`publicKey.ts`.

## Checks

```sh
npm run lint && npm run typecheck && npm test && npm run build
```

Tests run against a real `mongod` from `mongodb-memory-server` (downloaded on first run). Set
`MONGOMS_SYSTEM_BINARY` to use an installed one, or `TEST_MONGODB_URI` to use a running server.

## Deploy on Render

`render.yaml` is a Render Blueprint for one Node web service (`xquery-api`, health check `/health`).

1. **MongoDB Atlas.** Create a cluster and a database user. In Network Access, allow Render's outbound IPs (or
   0.0.0.0/0 to start). Copy the `mongodb+srv://…` string.
2. **Signing key.** Generate it offline with the app's `npm run license -- keygen`. Put the public half in the app's
   `publicKey.ts`, and paste the private PEM only into Render's `LICENSE_SIGNING_KEY` secret. Never commit it.
3. **Render.** New → Blueprint → this repo. Fill in the secrets it asks for: `MONGODB_URI`, `LICENSE_SIGNING_KEY`,
   `RESEND_API_KEY`, and optionally `TURNSTILE_SECRET`. It starts pointed at the website's Render service
   (`https://xquery-website.onrender.com`). Every push to `main` deploys.
4. **Domains and cookies.** The session cookie works best when the website and the API share a domain:
   - **Custom domains (recommended):** the website on `xquery.io`, the API on `api.xquery.io` (Render → Settings →
     Custom Domains). Set `COOKIE_DOMAIN=.xquery.io`, `COOKIE_SAME_SITE=lax`, `WEB_URL=https://xquery.io`, and
     `WEB_ORIGINS=https://xquery.io`.
   - **Before that, on `*.onrender.com`:** two onrender.com hosts count as different sites, so set
     `COOKIE_SAME_SITE=none`, leave `COOKIE_DOMAIN` empty, and set `WEB_ORIGINS` to the website's exact
     origin, `https://xquery-website.onrender.com` (the Blueprint's starting values). Browsers that block third-party cookies (Safari, and Chrome in some modes)
     will not keep users signed in this way, so move to custom domains before launch.
5. **Staff.** Register on the website, then run `npm run make-staff -- you@example.com` from a Render Shell.

Packaged app builds call the product service at `https://api.xquery.io/`, so give the API that custom domain before
the first release. This service never logs client IPs, as the app's privacy promise for the usage ping requires.
A `Dockerfile` is included too, if you ever move off Render's Node runtime.

## Not built yet

Google and GitHub sign-in, company domain claim, `policy.json` downloads for Enterprise teams, two-factor sign-in,
and Stripe billing (planned for when charging starts).
