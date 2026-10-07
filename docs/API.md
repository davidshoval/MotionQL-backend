# MotionQL API

Base URL `https://api.motionql.com` (development `http://localhost:4000`). The machine-readable description is served at
`GET /openapi.json`.

## Conventions

- **Session.** Signing in sets an httpOnly cookie `mq_session` (Secure in production, SameSite=Lax, or None when
  `COOKIE_SAME_SITE=none` for a site on another domain such as `*.onrender.com`, `Domain=COOKIE_DOMAIN`,
  e.g. `.motionql.com`, so motionql.com and api.motionql.com share it). Browser calls use `fetch(url, { credentials: 'include' })`.
  Sessions last 30 days.
- **Bodies** are JSON. A write from a browser must come from an origin in `WEB_ORIGINS`; anything else gets
  `403 bad_origin`.
- **Errors** always look like this, with a matching HTTP status:

  ```json
  { "error": { "code": "validation_failed", "message": "Some fields are not valid.", "fields": { "email": "Enter a valid e-mail address." } } }
  ```

  | Code | Status | When |
  |---|---|---|
  | `validation_failed` | 400 | A field is missing or wrong; `fields` says which |
  | `invalid_token` | 400 | An e-mail link is used, expired or unknown |
  | `captcha_failed` | 400 | Turnstile check failed (only when `TURNSTILE_SECRET` is set) |
  | `unauthorized` | 401 | Not signed in, or wrong e-mail/password |
  | `email_not_verified` | 403 | Signing in before confirming the e-mail |
  | `forbidden` | 403 | Signed in but not allowed (role, staff only) |
  | `invite_email_mismatch` | 403 | Accepting an invitation sent to another e-mail |
  | `not_found` | 404 | Unknown id, or a team the caller is not in |
  | `email_taken` | 409 | Registering an e-mail that has an account |
  | `seat_limit_reached` | 409 | Every seat of the team is in use |
  | `not_renewable` | 409 | Free key renewal is not open yet or is switched off |
  | `rate_limited` | 429 | Too many requests (sign-in style routes: 10 per minute per IP) |

- **Dates** are ISO 8601 strings in UTC. **Ids** are prefixed ULIDs (`usr_…`, `team_…`, `lic_…`).

## Accounts

| Method and path | Body | Result |
|---|---|---|
| `POST /auth/register` | `email, password (10+), name, company?, turnstileToken?, referralCode?, heardFrom? (100 chars), attribution?` | `201 {user}`. E-mails a link to `WEB_URL/verify-email?token=…` (valid 24 h). No session yet. |
| `POST /auth/verify-email` | `token` | `{user}`, sets the session, issues the free key and e-mails it. |
| `POST /auth/resend-verification` | `email` | `204` always (never reveals whether an account exists). |
| `POST /auth/login` | `email, password` | `{user}` and the session cookie. |
| `POST /auth/logout` | | `204` |
| `POST /auth/password-reset/request` | `email` | `204` always. Link to `WEB_URL/reset-password?token=…` (valid 1 h). |
| `POST /auth/password-reset/confirm` | `token, password` | `204`. Signs out every session. |
| `POST /auth/change-password` | `currentPassword, newPassword` | `204`. Signs out other sessions. |
| `GET /me` | | `{user, teams: [{id, name, role, hasSeat}], pendingInvites: [{id, teamName, role, invitedBy}]}` |
| `PATCH /me` | `name?, company? (null clears)` | `{user}` |
| `DELETE /me` | `password` | `204`. Deletes the account, revokes its keys, leaves its teams. `409 owns_team` while it owns a team with other members. |

`user` = `{id, email, name, company?, emailVerified, isStaff, createdAt}`.

`attribution` is where the visitor first came from, recorded by the website on their first page (first touch) and sent
with sign-up: `{utmSource?, utmMedium?, utmCampaign?, utmContent?, landingPath?, referrerHost?}`. The four `utm*`
fields are up to 100 characters, `landingPath` up to 300 and starting with `/`, `referrerHost` a host name (letters,
digits, `.`, `-`, optional `:port`) up to 253. No control characters; anything else is `400 validation_failed`. Empty
fields are dropped and `referrerHost` is lower-cased; it is stored on the user and shown in the staff user detail.

## License keys

| Method and path | Result |
|---|---|
| `GET /me/licenses` | `{licenses: [license]}`, newest first |
| `POST /me/licenses/renew` | `201 {license}`: a fresh free key, from `renewWindowDays` (30) before expiry, or when the user has none |
| `POST /me/licenses/:licenseId/reissue` | `201 {license}`: replaces a lost or leaked personal key (same expiry); the old one is revoked |
| `GET /plans/free` | `{enabled, edition, features, durationDays, renewable}`, public, for pricing and sign-up copy |

`license` = `{licenseId, key, edition, features, customer, email, seats, issuedAt, expiresAt, status, source, revokedAt?, team?: {id, name}}`.
`key` is the full `MQL1.…` key the user pastes into Settings → License. `status` is `active`, `expired`, `revoked` or
`replaced` (reissued). `source` is `free`, `team` or `staff`.

## Refer a friend

| Method and path | Result |
|---|---|
| `GET /me/referral` | `{code, url, signups, confirmed, rewarded, reward: {bonusDays, maxRewards, remaining} \| null}`. `url` is `WEB_URL/r/CODE`; accounts made before referrals get a code on first call. |
| `GET /referrals/:code` | Public, for the `/r/CODE` landing page: `{code, inviterName (first name only), reward: {bonusDays} \| null}`; `404` for an unknown code. Case-insensitive. |

Signing up with `referralCode` records who invited the user (an unknown code is ignored). `reward` is `null` while the
staff switch is off (the default). When it is on and the invited user confirms their e-mail, both get `bonusDays` more:
the friend's first free key runs that much longer, and the inviter gets a new free key running `bonusDays` past their
current one, by e-mail (the old key keeps working to its own date). An inviter with no active free key gets the days
on their next free key. Each invited user pays out once, and each inviter earns at most `maxRewardsPerUser` rewards.

## Downloads

`GET /downloads/latest` → `{version, publishedAt, releaseNotesUrl, files: [{name, os, arch, kind, size, sha256?, url}]}`
from the latest release of `RELEASES_REPO` (public GitHub repo), cached 10 minutes. `os`: `macos | windows | linux`;
`arch`: `arm64 | x64 | universal`; `kind`: `dmg | zip | exe | msi | appimage | deb | rpm`. `sha256` comes from the
release's `SHA256SUMS.txt`.

## Teams

Every member of a team can read it; admins and the owner manage it. Staff can act on any team.

| Method and path | Who | Body | Result |
|---|---|---|---|
| `POST /teams` | signed in | `name` | `201 {team}`; the caller is owner and takes a seat |
| `GET /teams/:teamId` | member | | `{team, role}` |
| `PATCH /teams/:teamId` | admin | `name` | `{team}` |
| `DELETE /teams/:teamId` | owner | | `204`; every team key is revoked |
| `POST /teams/:teamId/transfer-ownership` | owner | `userId` | `204`; the old owner becomes admin |
| `GET /teams/:teamId/members` | member | | `{members: [member]}` (`usage` only for admins) |
| `PATCH /teams/:teamId/members/:userId` | admin | `role? (admin\|member, owner only), edition?, features?` | `{member}`; a seated member gets a new key |
| `DELETE /teams/:teamId/members/:userId` | admin, or self to leave | | `204`; frees the seat and revokes the key |
| `POST /teams/:teamId/seats/:userId` | admin | | `201 {license}`; e-mails the key |
| `DELETE /teams/:teamId/seats/:userId` | admin | | `204`; revokes the key |
| `POST /teams/:teamId/members/:userId/reissue` | admin | | `201 {license}`; old key revoked |
| `POST /teams/:teamId/invites` | admin | `emails[1..100], role (member), assignSeat (true)` | `201 {invites, skipped: [{email, reason}]}`; link to `WEB_URL/invite?token=…` (14 days) |
| `GET /teams/:teamId/invites` | admin | | `{invites}` |
| `POST /teams/:teamId/invites/:inviteId/resend` | admin | | `204` |
| `DELETE /teams/:teamId/invites/:inviteId` | admin | | `204` |
| `GET /teams/:teamId/audit?before=&limit=` | admin | | `{events: [{id, at, actor, action, target, details}], nextCursor}` |
| `GET /teams/:teamId/audit.csv` | admin | | CSV download |
| `POST /invites/preview` | anyone | `token` | `{teamName, email, role, invitedBy, assignSeat}` |
| `POST /invites/accept` | signed in, invited e-mail | `token` | `{team, seatAssigned}`; joins without a seat when the team is full |

`team` = `{id, name, seatLimit, seatsUsed, allowedEditions, allowedFeatures, createdAt}`.
`member` = `{userId, email, name, role, hasSeat, edition, features, joinedAt, license?: {licenseId, edition, features, issuedAt, expiresAt, status}, usage?: {lastSeen, appVersion, platform, installs}}`.
`usage` comes from the app's opt-in usage ping, matched by license hash.

## Staff console

Staff only (`npm run make-staff -- you@example.com`). Every change is in the audit log.

| Method and path | Purpose |
|---|---|
| `GET /admin/overview` | Users, teams, active and revoked keys, active installs |
| `GET /admin/plans` | `{free, team, referral}` settings |
| `PUT /admin/plans/free` | `enabled, edition, features, durationDays, renewable, renewWindowDays` (any subset). The free-year switch: applies to keys issued after the change. |
| `PUT /admin/plans/team` | `defaultSeatLimit, edition, durationDays` for new teams and seats |
| `PUT /admin/plans/referral` | `enabled` (default `false`), `bonusDays` (90), `maxRewardsPerUser` (12): the refer-a-friend reward |
| `GET /admin/referrals?limit=` | `{referredSignups, heardFromAnswers, topInviters: [{userId, email, name, signups, confirmed, rewarded}], heardFrom: [{answer, count}]}` |
| `GET /admin/acquisition?from=&to=` | Sign-ups per first-touch `utm_source`, below |
| `GET /admin/retention?from=&to=` | App install retention from the opt-in usage pings, below |
| `GET /admin/users?q=` · `GET /admin/users/:userId` · `PUT /admin/users/:userId/staff` | Look up users (the detail includes `referral: {code, referredBy, heardFrom, rewardedAt, bonusDays, signups}` and `attribution` or `null`); grant or remove staff |
| `GET /admin/teams?q=` · `PATCH /admin/teams/:teamId` | `seatLimit, allowedEditions, allowedFeatures` |
| `GET /admin/licenses?q=` | Search by license id, hash, e-mail or customer |
| `POST /admin/licenses` | `email, customer, edition, features, durationDays`: a key by hand |
| `POST /admin/licenses/:licenseId/revoke` | `reason` |
| `POST /admin/licenses/:licenseId/extend` | `days`: a replacement key that runs that much longer |
| `GET /admin/manifest` · `PUT /admin/manifest` | `requiredUpdate, notifications, includeRevocations` (checked with the app's manifest validator) |
| `GET /admin/audit?teamId=&before=&limit=` | Everything, newest first |
| `GET /admin/feedback?status=&before=&limit=` | Feedback, newest first: `{feedback, nextCursor}` |
| `PATCH /admin/feedback/:feedbackId` | `status`: `new`, `read` or `done` |

### Acquisition and retention

Both take an optional `from` (inclusive) and `to` (exclusive): an ISO date-time or a bare date (`2026-10-01`, midnight
UTC). `from` must be before `to`, or `400`. Without them the report covers everything.

`GET /admin/acquisition` counts accounts created in the range, grouped by `attribution.utmSource` (lower-cased;
`null` for sign-ups without one):

```json
{ "from": "2026-10-01T00:00:00.000Z", "to": null,
  "totals": { "signups": 10, "confirmed": 9, "companies": 5, "activated": 2 },
  "sources": [{ "utmSource": "newsletter", "signups": 7, "confirmed": 6, "companies": 3, "companies2Plus": 2, "companies3Plus": 1, "activated": 2 }] }
```

- `companies`: distinct e-mail domains among those sign-ups, leaving out personal mailboxes (`gmail.com`,
  `outlook.com`, `gmx.*`, `yandex.*` and the rest of `src/lib/freeMail.ts`).
- `companies2Plus` / `companies3Plus`: of those companies, how many have 2+ / 3+ accounts at their domain created
  before `to`, whatever brought those colleagues in. A company can count under more than one source.
- `activated`: users with a key (any source) whose hash the app has sent in `POST /v1/ping`.
- `sources` is sorted by sign-ups, most first.

`GET /admin/retention` builds on `POST /v1/usage`. An install's first day is the UTC day of its first event; the range
filters on it. `dN` counts installs active (any event) on the Nth day after their first day, among those for which
that day is already over:

```json
{ "from": null, "to": null, "days": [1, 7, 30],
  "totals": { "installs": 4, "linkedInstalls": 2, "d1": { "eligible": 3, "retained": 2, "rate": 0.667 }, "d7": {…}, "d30": {…} },
  "cohorts": [{ "week": "2026-09-28", "installs": 3, "d1": {…}, "d7": {…}, "d30": {…} }],
  "bySource": [{ "utmSource": "newsletter", "installs": 1, "d1": {…}, "d7": {…}, "d30": {…} }] }
```

`week` is the Monday (UTC) of the cohort. `rate` is `retained / eligible` (3 decimals), `null` while nobody is eligible.
`bySource` only holds installs linked to an account: the latest `licenseId` the install sent matches a key owned by a
user, grouped by that user's `utmSource` (`null` when they have none). `linkedInstalls` is how many those are.

## Feedback

Stored in the `feedback` collection and e-mailed to every address in `STAFF_EMAILS`, with Reply-To set to the
sender's address when there is one. A failed e-mail never fails the request. Both routes allow 10 per minute per IP
and answer `204`.

| Method and path | Body |
|---|---|
| `POST /feedback` | The website form: `kind` (`bug`, `idea`, `praise`, `other`), `message` (3 to 5000 characters), `email` (optional; a signed-in user's own address when empty), `page` (optional path, e.g. `/pricing`). A hidden `website` field that bots fill in makes the message be dropped. |
| `POST /v1/feedback` | The app's Help > Send feedback, no cookies: `kind`, `message`, `email` (optional), `app: {version, platform, arch, channel?, edition?}`. Unknown fields are refused. |

## Desktop app (product service)

Exactly as the app's `docs/PRODUCT_SERVICE.md` describes:

- `GET /v1/manifest`: the `MQLM1.…` signed token, `text/plain`. Re-signed with a newer `issuedAt` only when its content
  changes. With `includeRevocations` on (the default), it carries `revokedLicenses`: `sha256("motionql-license-id:" + licenseId)`
  of every revoked key that has not expired. Every released app (1.0.0 on) reads the field; only pre-release builds
  refuse a manifest with unknown keys.
- `POST /v1/ping`: the anonymous usage ping. Unknown fields are refused; only `firstSeen`/`lastSeen` and the ping's
  fields are stored, never the IP, and a TTL index deletes installs 25 months after they were last seen.
- `POST /v1/usage`: opt-in usage events; the app sends them only after the user turns them on in its settings. No
  cookies. Body (unknown fields are refused, `400`):

  | Field | |
  |---|---|
  | `installId` | Random UUID the app generates once; not derived from the hardware |
  | `appVersion` | e.g. `1.4.2` |
  | `os` | `process.platform` style: lower-case letters, digits, `_`, up to 16 (`darwin`, `win32`, `linux`) |
  | `arch` | Same rule (`arm64`, `x64`) |
  | `event` | `app_open`, `first_connection` or `active_day` |
  | `licenseId` | Optional, sent only while a paid license is active. The license hash the app already has, `sha256("motionql-license-id:" + licenseId)`, 64 hex |

  `app_open` is stored every time. Only the first `first_connection` per `installId` is kept (installs that upgrade
  send one late; repeats are ignored), and one `active_day` per `installId` per UTC day. Repeats still answer `204`.

  Answers `204`. Stored in `usage_events` with the server's date (`at`); `licenseId` is kept as `licenseHash`. Never
  the IP or any other request detail. A TTL index deletes events 25 months after they were written. Rate-limited per
  IP like `/v1/feedback` (10 per minute).
- `GET /health`: `{ok: true}` when MongoDB answers.
