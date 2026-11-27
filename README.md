# Resonance

A music compatibility project. The current NestJS API supports user registration,
JWT login, Spotify account linking, and saved taste profiles containing top artists
and tracks. Two-person taste comparison is planned next.

The backend lives in [`apps/api`](apps/api). Follow the
[API setup guide](apps/api/README.md) for PostgreSQL, environment variables,
Spotify configuration, and a manual connection test.

## Development checks

Use Node.js 24.15 or later in the 24.x line. From `apps/api`:

```powershell
npm ci
npm run prisma:generate
npm run lint
npm test -- --runInBand
npm run test:e2e -- --runInBand
npm run build
```

Prisma generation uses `prisma7.config.ts`; set `DATABASE_URL` in `.env` or the
environment first. Generation does not open a database connection.

[API CI](.github/workflows/api-ci.yml) runs these checks on pull requests and
pushes to `main`. Unit tests mock Spotify HTTP requests and Prisma. HTTP tests use
the real application routes, JWT guard, validation, and throttling with mocked
Spotify and database providers. They need no Spotify credentials or running
database; they do not verify migrations or database cascade behavior.
