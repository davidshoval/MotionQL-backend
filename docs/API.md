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
| `POST /auth/register` | `email, password (10+), name, company?, turnstileToken?` | `201 {user}`. E-mails a link to `WEB_URL/verify-email?token=…` (valid 24 h). No session yet. |
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
| `GET /admin/plans` | `{free, team}` settings |
| `PUT /admin/plans/free` | `enabled, edition, features, durationDays, renewable, renewWindowDays` (any subset). The free-year switch: applies to keys issued after the change. |
| `PUT /admin/plans/team` | `defaultSeatLimit, edition, durationDays` for new teams and seats |
| `GET /admin/users?q=` · `GET /admin/users/:userId` · `PUT /admin/users/:userId/staff` | Look up users; grant or remove staff |
| `GET /admin/teams?q=` · `PATCH /admin/teams/:teamId` | `seatLimit, allowedEditions, allowedFeatures` |
| `GET /admin/licenses?q=` | Search by license id, hash, e-mail or customer |
| `POST /admin/licenses` | `email, customer, edition, features, durationDays`: a key by hand |
| `POST /admin/licenses/:licenseId/revoke` | `reason` |
| `POST /admin/licenses/:licenseId/extend` | `days`: a replacement key that runs that much longer |
| `GET /admin/manifest` · `PUT /admin/manifest` | `requiredUpdate, notifications, includeRevocations` (checked with the app's manifest validator) |
| `GET /admin/audit?teamId=&before=&limit=` | Everything, newest first |
| `GET /admin/feedback?status=&before=&limit=` | Feedback, newest first: `{feedback, nextCursor}` |
| `PATCH /admin/feedback/:feedbackId` | `status`: `new`, `read` or `done` |

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
- `GET /health`: `{ok: true}` when MongoDB answers.
