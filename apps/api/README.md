# Resonance API

NestJS, TypeScript, Prisma, and PostgreSQL backend for Resonance. Run the commands
below from `apps/api` unless stated otherwise.

## Local setup

1. Install Node.js 24.15 or later in the 24.x line and start PostgreSQL. Create an
   empty database named `resonance` with a user that can apply migrations.
2. Install the locked dependencies and copy the environment template:

   ```powershell
   npm ci
   Copy-Item .env.example .env
   ```

3. Edit `.env` with your database URL and Spotify app credentials. Generate two
   separate random values with the command below: use one as `JWT_ACCESS_SECRET`
   and the other as `SPOTIFY_TOKEN_ENCRYPTION_KEY`.

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   | Variable                       | Purpose                                                                       |
   | ------------------------------ | ----------------------------------------------------------------------------- |
   | `DATABASE_URL`                 | PostgreSQL connection URL, including username, password, and database         |
   | `JWT_ACCESS_SECRET`            | JWT signing secret, at least 32 bytes; tokens expire after 15 minutes         |
   | `SPOTIFY_CLIENT_ID`            | Client ID from your Spotify developer app                                     |
   | `SPOTIFY_CLIENT_SECRET`        | Client secret from the same app                                               |
   | `SPOTIFY_REDIRECT_URI`         | Registered callback URL; locally use `http://127.0.0.1:4000/spotify/callback` |
   | `SPOTIFY_TOKEN_ENCRYPTION_KEY` | Exactly 64 hexadecimal characters for AES-256-GCM token encryption            |
   | `NODE_ENV`                     | `development` enables the manual Spotify test page                            |
   | `PORT`                         | HTTP port; defaults to `4000`                                                 |

   Keep `.env` private. Keep the encryption key stable: saved Spotify tokens
   require the same key to decrypt. Changing it requires users to reconnect.

4. Generate the Prisma client, apply the committed migrations, and start the API:

   ```powershell
   npm run prisma:generate
   npm run db:migrate
   npm run start:dev
   ```

   The Prisma scripts explicitly load `prisma7.config.ts`.

5. Check `http://127.0.0.1:4000/` for `Hello World!` and
   `http://127.0.0.1:4000/health/db` for database connectivity.

## Spotify connection test

Register the exact `SPOTIFY_REDIRECT_URI` in the settings of your
[Spotify developer app](https://developer.spotify.com/dashboard). The API accepts
HTTPS callbacks and HTTP loopback callbacks with the `/spotify/callback` path.
For local use, open the API with `127.0.0.1` consistently so the OAuth state cookie
reaches the callback.

1. Create a Resonance account with `POST /auth/register`, then log in with
   `POST /auth/login`. The registration response does not include an access token.

   ```powershell
   $registration = @{
     username = 'listener'
     email = 'listener@example.com'
     password = 'ChooseYourOwnStrongPassword123!'
     displayName = 'Listener'
   } | ConvertTo-Json
   Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4000/auth/register `
     -ContentType application/json -Body $registration
   ```

2. With `NODE_ENV=development`, open `http://127.0.0.1:4000/spotify/test` in your
   browser. Log in with that account and click **Connect Spotify**.
3. Approve Spotify access. The API requests `user-read-private` and
   `user-top-read`. If Spotify denies access, check the app's current development
   access settings and that the account has permission to use it.
4. After the callback says **Spotify connected**, return to the test page and
   click **Connection status**, then **Sync**. Choose `short_term`, `medium_term`,
   or `long_term`; an omitted range defaults to `medium_term`.
5. Click **Read saved profile** to retrieve persisted data without contacting
   Spotify. **Disconnect and delete saved Spotify data** removes the local
   connection, pending OAuth requests, and saved taste profiles. This endpoint
   does not call Spotify to revoke consent.

The test page keeps the Resonance JWT in memory. Log in again after a refresh or
token expiry. Connect and sync allow three requests per minute per IP; login
allows five, registration three, and the default limit is 60.

## Routes

Protected routes use `Authorization: Bearer <accessToken>` from `/auth/login`.
The callback uses a one-use state value and an HTTP-only state cookie instead
of a Resonance JWT.

| Method   | Route                                  | Authentication           | Result                                                               |
| -------- | -------------------------------------- | ------------------------ | -------------------------------------------------------------------- |
| `POST`   | `/auth/register`                       | Public                   | Create an account                                                    |
| `POST`   | `/auth/login`                          | Public                   | Receive an access token                                              |
| `GET`    | `/auth/me`                             | JWT                      | Current user                                                         |
| `POST`   | `/spotify/connect`                     | JWT                      | Authorization URL and state cookie                                   |
| `GET`    | `/spotify/callback`                    | OAuth state + cookie     | Link the Spotify account                                             |
| `GET`    | `/spotify/status`                      | JWT                      | Connection details and saved ranges                                  |
| `POST`   | `/spotify/sync`                        | JWT                      | Fetch and save top items; JSON body `{ "timeRange": "medium_term" }` |
| `GET`    | `/spotify/taste?timeRange=medium_term` | JWT                      | Read the saved profile                                               |
| `DELETE` | `/spotify/disconnect`                  | JWT                      | Delete local Spotify data                                            |
| `GET`    | `/spotify/test`                        | Public, development only | Manual connection test page                                          |

Each sync stores up to 50 artists and 50 tracks for the chosen range, with rank,
Spotify ID, name, image, and Spotify link. Tracks without an ID are skipped.
Sync refreshes expiring tokens, deduplicates concurrent refreshes within one API
process, and retries top-item requests once after a Spotify 401.

If authorization was revoked, the API returns `SPOTIFY_RECONNECT_REQUIRED` and
removes the stale local connection. Rate-limit responses include
`retryAfterSeconds` when Spotify supplies a valid `Retry-After` value.

## Checks and CI

```powershell
npm run lint
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run build
```

Generate the Prisma client before running checks on a fresh checkout. Tests use
fixed test credentials and mocked Spotify/database providers. HTTP tests exercise
JWT protection, callback cookies, DTO validation, route behavior, and throttling.
They do not apply database migrations or verify real PostgreSQL transactions,
unique constraints, cascades, or live Spotify consent. Use the manual flow above
to verify the real integration.

The repository's GitHub Actions workflow installs with `npm ci`, generates
Prisma, lints, runs unit and HTTP tests, and builds on Node.js 24. No repository
secrets or live service accounts are needed for these checks.

For production, build with `npm run build`, apply migrations to the intended
database, and run `npm run start:prod` with production environment variables and
an HTTPS Spotify callback.
