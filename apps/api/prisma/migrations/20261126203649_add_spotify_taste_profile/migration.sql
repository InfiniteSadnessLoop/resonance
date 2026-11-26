-- CreateEnum
CREATE TYPE "SpotifyTimeRange" AS ENUM ('short_term', 'medium_term', 'long_term');

-- CreateTable
CREATE TABLE "SpotifyOAuthState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "SpotifyOAuthState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpotifyConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "spotifyAccountId" TEXT NOT NULL,
    "displayName" TEXT,
    "accessTokenEncrypted" TEXT NOT NULL,
    "refreshTokenEncrypted" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "scope" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SpotifyConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SpotifyTasteProfile" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "timeRange" "SpotifyTimeRange" NOT NULL,
    "artists" JSONB NOT NULL,
    "tracks" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SpotifyTasteProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SpotifyOAuthState_expiresAt_idx" ON "SpotifyOAuthState"("expiresAt");

-- CreateIndex
CREATE INDEX "SpotifyOAuthState_userId_idx" ON "SpotifyOAuthState"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SpotifyConnection_userId_key" ON "SpotifyConnection"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "SpotifyConnection_spotifyAccountId_key" ON "SpotifyConnection"("spotifyAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "SpotifyTasteProfile_connectionId_timeRange_key" ON "SpotifyTasteProfile"("connectionId", "timeRange");

-- AddForeignKey
ALTER TABLE "SpotifyOAuthState" ADD CONSTRAINT "SpotifyOAuthState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpotifyConnection" ADD CONSTRAINT "SpotifyConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SpotifyTasteProfile" ADD CONSTRAINT "SpotifyTasteProfile_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "SpotifyConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
