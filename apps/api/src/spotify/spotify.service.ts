import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

import { Prisma } from '../generated/prisma/client';
import type {
  SpotifyConnection,
} from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { TasteQueryDto } from './spotify.dto';

type TimeRange = TasteQueryDto['timeRange'];

type TokenReply = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
};

type Artist = {
  id: string;
  name: string;
  images?: { url: string }[];
};

type Track = {
  id: string | null;
  name: string;
  artists: {
    id: string | null;
    name: string;
  }[];
  album?: {
    images?: { url: string }[];
  };
};

const SCOPE = 'user-read-private user-top-read';

@Injectable()
export class SpotifyService {
  private readonly clientId: string;
  private readonly clientSecret: string;
  readonly redirectUri: string;

  private readonly key: Buffer;

  // Deduplicate refreshes inside one API process.
  private readonly refreshing =
    new Map<string, Promise<SpotifyConnection>>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.clientId =
      config.getOrThrow<string>('SPOTIFY_CLIENT_ID');

    this.clientSecret =
      config.getOrThrow<string>('SPOTIFY_CLIENT_SECRET');

    this.redirectUri =
      config.getOrThrow<string>('SPOTIFY_REDIRECT_URI');

    const key = config.getOrThrow<string>(
      'SPOTIFY_TOKEN_ENCRYPTION_KEY',
    );

    if (!/^[a-fA-F0-9]{64}$/.test(key)) {
      throw new Error(
        'SPOTIFY_TOKEN_ENCRYPTION_KEY must be 64 hex characters',
      );
    }

    this.key = Buffer.from(key, 'hex');

    const uri = new URL(this.redirectUri);
    const loopback = [
      '127.0.0.1',
      '[::1]',
    ].includes(uri.hostname);

    if (
      !(
        uri.protocol === 'https:' ||
        (uri.protocol === 'http:' && loopback)
      ) ||
      uri.pathname !== '/spotify/callback' ||
      uri.search ||
      uri.hash ||
      uri.username ||
      uri.password
    ) {
      throw new Error(
        'Use an HTTPS or loopback /spotify/callback redirect URI',
      );
    }
  }

  async connect(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });

    if (!user) {
      throw new UnauthorizedException(
        'User account no longer exists',
      );
    }

    const state = randomBytes(32).toString('hex');

    await this.prisma.$transaction(async (tx) => {
      await tx.spotifyOAuthState.deleteMany({
        where: {
          OR: [
            { userId },
            { expiresAt: { lte: new Date() } },
          ],
        },
      });

      await tx.spotifyOAuthState.create({
        data: {
          id: this.hash(state),
          userId,
          expiresAt: new Date(
            Date.now() + 10 * 60_000,
          ),
        },
      });
    });

    const url = new URL(
      'https://accounts.spotify.com/authorize',
    );

    url.search = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: SCOPE,
      state,
      show_dialog: 'true',
    }).toString();

    return {
      state,
      authorizationUrl: url.toString(),
    };
  }

  async callback(
    state: unknown,
    cookie: string,
    code: unknown,
    error: unknown,
  ) {
    if (
      typeof state !== 'string' ||
      !/^[a-f0-9]{64}$/.test(state) ||
      !/^[a-f0-9]{64}$/.test(cookie) ||
      !timingSafeEqual(
        Buffer.from(state),
        Buffer.from(cookie),
      )
    ) {
      throw new BadRequestException(
        'Invalid OAuth state. Start connecting again',
      );
    }

    const id = this.hash(state);

    const pending =
      await this.prisma.spotifyOAuthState.findUnique({
        where: { id },
      });

    if (!pending) {
      throw new BadRequestException(
        'OAuth request already used or missing',
      );
    }

    const claimed =
      await this.prisma.spotifyOAuthState.updateMany({
        where: {
          id,
          expiresAt: { gt: new Date() },
          consumedAt: null,
        },
        data: {
          consumedAt: new Date(),
        },
      });

    if (claimed.count !== 1) {
      throw new BadRequestException(
        'OAuth request expired or already used',
      );
    }

    if (error) {
      await this.prisma.spotifyOAuthState.deleteMany({
        where: { id },
      });

      throw new BadRequestException(
        'Spotify authorization was cancelled',
      );
    }

    if (
      typeof code !== 'string' ||
      !code ||
      code.length > 4096
    ) {
      throw new BadRequestException(
        'Spotify did not return an authorization code',
      );
    }

    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
    });

    if (
      !tokens.refresh_token ||
      !tokens.scope?.split(' ').includes('user-top-read')
    ) {
      throw new BadRequestException(
        'Spotify did not grant the required permissions',
      );
    }

    const me = await this.request<{
      account_id: string;
      display_name: string | null;
    }>('https://api.spotify.com/v1/me', {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`,
      },
    });

    if (
      typeof me.account_id !== 'string' ||
      !me.account_id
    ) {
      throw new BadGatewayException(
        'Spotify did not return its stable account_id',
      );
    }

    try {
      await this.prisma.$transaction(async (tx) => {
        const active =
          await tx.spotifyOAuthState.deleteMany({
            where: {
              id,
              userId: pending.userId,
              expiresAt: { gt: new Date() },
            },
          });

        if (active.count !== 1) {
          throw new BadRequestException(
            'Connection request was cancelled. Start again',
          );
        }

        // A fresh ID prevents old syncs from writing
        // after an account is disconnected or relinked.
        await tx.spotifyConnection.deleteMany({
          where: { userId: pending.userId },
        });

        await tx.spotifyConnection.create({
          data: {
            userId: pending.userId,
            spotifyAccountId: me.account_id,
            displayName: me.display_name ?? null,

            accessTokenEncrypted: this.encrypt(
              tokens.access_token,
              pending.userId,
            ),

            refreshTokenEncrypted: this.encrypt(
              tokens.refresh_token!,
              pending.userId,
            ),

            expiresAt: new Date(
              Date.now() + tokens.expires_in * 1000,
            ),

            scope: tokens.scope!,
          },
        });
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException(
          'That Spotify account is already linked',
        );
      }

      throw e;
    }

    return { connected: true };
  }

  async status(userId: string) {
    const connection =
      await this.prisma.spotifyConnection.findUnique({
        where: { userId },
        select: {
          displayName: true,
          createdAt: true,
          profiles: {
            select: {
              timeRange: true,
              fetchedAt: true,
            },
          },
        },
      });

    return connection
      ? { connected: true, ...connection }
      : { connected: false };
  }

  async profile(
    userId: string,
    timeRange: TimeRange,
  ) {
    const profile =
      await this.prisma.spotifyTasteProfile.findFirst({
        where: {
          connection: { userId },
          timeRange,
        },
        select: {
          timeRange: true,
          fetchedAt: true,
          artists: true,
          tracks: true,
        },
      });

    if (!profile) {
      throw new NotFoundException(
        'No saved profile for this time range. Sync it first',
      );
    }

    return profile;
  }

  async sync(
    userId: string,
    timeRange: TimeRange,
  ) {
    let connection =
      await this.prisma.spotifyConnection.findUnique({
        where: { userId },
      });

    if (!connection) {
      throw new BadRequestException(
        'Connect Spotify first',
      );
    }

    connection = await this.validConnection(connection);

    let top: Awaited<
      ReturnType<SpotifyService['fetchTop']>
    >;

    try {
      top = await this.fetchTop(connection, timeRange);
    } catch (e) {
      if (!(e instanceof UnauthorizedException)) {
        throw e;
      }

      connection = await this.validConnection(
        connection,
        true,
      );

      top = await this.fetchTop(connection, timeRange);
    }

    try {
      await this.prisma.spotifyTasteProfile.upsert({
        where: {
          connectionId_timeRange: {
            connectionId: connection.id,
            timeRange,
          },
        },

        create: {
          connectionId: connection.id,
          timeRange,
          ...top,
          fetchedAt: new Date(),
        },

        update: {
          ...top,
          fetchedAt: new Date(),
        },
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2003'
      ) {
        throw new BadRequestException(
          'Spotify connection changed. Sync again',
        );
      }

      throw e;
    }

    return this.profile(userId, timeRange);
  }

  async disconnect(userId: string) {
    await this.prisma.$transaction(async (tx) => {
      await tx.spotifyOAuthState.deleteMany({
        where: { userId },
      });

      // Database cascade removes saved taste profiles.
      await tx.spotifyConnection.deleteMany({
        where: { userId },
      });
    });

    return { connected: false };
  }

  private async fetchTop(
    connection: SpotifyConnection,
    timeRange: TimeRange,
  ) {
    const headers = {
      Authorization: `Bearer ${this.decrypt(
        connection.accessTokenEncrypted,
        connection.userId,
      )}`,
    };

    const query = new URLSearchParams({
      time_range: timeRange,
      limit: '50',
    });

    const [artists, tracks] = await Promise.all([
      this.request<{ items: Artist[] }>(
        `https://api.spotify.com/v1/me/top/artists?${query}`,
        { headers },
      ),

      this.request<{ items: Track[] }>(
        `https://api.spotify.com/v1/me/top/tracks?${query}`,
        { headers },
      ),
    ]);

    if (
      !Array.isArray(artists.items) ||
      !Array.isArray(tracks.items)
    ) {
      throw new BadGatewayException(
        'Spotify returned an invalid top-items response',
      );
    }

    return {
      artists: artists.items.map((artist, index) => ({
        rank: index + 1,
        spotifyId: artist.id,
        name: artist.name,
        imageUrl: artist.images?.[0]?.url ?? null,
        spotifyUrl:
          'https://open.spotify.com/artist/' +
          encodeURIComponent(artist.id),
      })),

      tracks: tracks.items.flatMap((track, index) =>
        track.id
          ? [{
              rank: index + 1,
              spotifyId: track.id,
              name: track.name,

              artists: track.artists.map((artist) => ({
                spotifyId: artist.id,
                name: artist.name,
              })),

              imageUrl:
                track.album?.images?.[0]?.url ?? null,

              spotifyUrl:
                'https://open.spotify.com/track/' +
                encodeURIComponent(track.id),
            }]
          : [],
      ),
    };
  }

  private async validConnection(
    connection: SpotifyConnection,
    force = false,
  ): Promise<SpotifyConnection> {
    if (
      !force &&
      connection.expiresAt.getTime() >
        Date.now() + 30_000
    ) {
      return connection;
    }

    const existing = this.refreshing.get(connection.id);

    if (existing) {
      return existing;
    }

    const task = this.refresh(connection, force);
    this.refreshing.set(connection.id, task);

    try {
      return await task;
    } finally {
      this.refreshing.delete(connection.id);
    }
  }

  private async refresh(
    original: SpotifyConnection,
    force: boolean,
  ) {
    const current =
      await this.prisma.spotifyConnection.findUnique({
        where: { id: original.id },
      });

    if (!current) {
      throw new BadRequestException(
        'Connect Spotify first',
      );
    }

    if (
      current.accessTokenEncrypted !==
        original.accessTokenEncrypted ||
      (
        !force &&
        current.expiresAt.getTime() >
          Date.now() + 30_000
      )
    ) {
      return current;
    }

    let tokens: TokenReply;

    try {
      tokens = await this.tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: this.decrypt(
          current.refreshTokenEncrypted,
          current.userId,
        ),
      });
    } catch (e) {
      if (e instanceof BadRequestException) {
        await this.prisma.spotifyConnection.deleteMany({
          where: {
            id: current.id,
            accessTokenEncrypted:
              current.accessTokenEncrypted,
          },
        });
      }

      throw e;
    }

    await this.prisma.spotifyConnection.updateMany({
      where: {
        id: current.id,
        accessTokenEncrypted:
          current.accessTokenEncrypted,
      },

      data: {
        accessTokenEncrypted: this.encrypt(
          tokens.access_token,
          current.userId,
        ),

        refreshTokenEncrypted: tokens.refresh_token
          ? this.encrypt(
              tokens.refresh_token,
              current.userId,
            )
          : current.refreshTokenEncrypted,

        expiresAt: new Date(
          Date.now() + tokens.expires_in * 1000,
        ),

        scope: tokens.scope ?? current.scope,
      },
    });

    const updated =
      await this.prisma.spotifyConnection.findUnique({
        where: { id: current.id },
      });

    if (!updated) {
      throw new BadRequestException(
        'Spotify was disconnected',
      );
    }

    return updated;
  }

  private async tokenRequest(
    parameters: Record<string, string>,
  ) {
    const credentials = Buffer.from(
      `${this.clientId}:${this.clientSecret}`,
    ).toString('base64');

    const tokens = await this.request<TokenReply>(
      'https://accounts.spotify.com/api/token',
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/x-www-form-urlencoded',
          Authorization: `Basic ${credentials}`,
        },

        body: new URLSearchParams(
          parameters,
        ).toString(),
      },
    );

    if (
      typeof tokens.access_token !== 'string' ||
      !tokens.access_token ||
      !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in <= 0 ||
      (
        tokens.refresh_token !== undefined &&
        (
          typeof tokens.refresh_token !== 'string' ||
          !tokens.refresh_token
        )
      ) ||
      (
        tokens.scope !== undefined &&
        typeof tokens.scope !== 'string'
      )
    ) {
      throw new BadGatewayException(
        'Spotify returned invalid token data',
      );
    }

    return tokens;
  }

  private async request<T>(
    url: string,
    init: RequestInit,
  ): Promise<T> {
    let response: Response;
    let body: unknown;

    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new ServiceUnavailableException(
        'Spotify is unavailable. Try again later',
      );
    }

    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (!response.ok) {
      const oauthError =
        body &&
        typeof body === 'object' &&
        'error' in body
          ? body.error
          : undefined;

      if (oauthError === 'invalid_grant') {
        throw new BadRequestException({
          code: 'SPOTIFY_RECONNECT_REQUIRED',
          message:
            'Spotify authorization expired or was revoked. Connect again',
        });
      }

      if (response.status === 429) {
        const retry = Number(
          response.headers.get('Retry-After'),
        );

        throw new HttpException(
          {
            message: 'Spotify request limit reached',

            retryAfterSeconds:
              Number.isFinite(retry) && retry > 0
                ? retry
                : null,
          },
          429,
        );
      }

      if (response.status === 401) {
        throw new UnauthorizedException(
          'Spotify rejected its access token',
        );
      }

      if (response.status === 403) {
        throw new ForbiddenException(
          'Spotify denied access. Check app allowlist and permissions',
        );
      }

      throw new BadGatewayException(
        'Spotify request failed. Try connecting again',
      );
    }

    if (!body || typeof body !== 'object') {
      throw new BadGatewayException(
        'Spotify returned invalid JSON data',
      );
    }

    return body as T;
  }

  private hash(value: string) {
    return createHash('sha256')
      .update(value)
      .digest('hex');
  }

  private encrypt(
    value: string,
    userId: string,
  ) {
    const iv = randomBytes(12);

    const cipher = createCipheriv(
      'aes-256-gcm',
      this.key,
      iv,
    );

    cipher.setAAD(Buffer.from(userId));

    const encrypted = Buffer.concat([
      cipher.update(value, 'utf8'),
      cipher.final(),
    ]);

    return [
      iv,
      cipher.getAuthTag(),
      encrypted,
    ]
      .map((part) => part.toString('base64url'))
      .join('.');
  }

  private decrypt(
    value: string,
    userId: string,
  ) {
    const parts = value.split('.');

    if (parts.length !== 3) {
      throw new Error(
        'Invalid encrypted Spotify token',
      );
    }

    const [iv, tag, encrypted] = parts.map(
      (part) => Buffer.from(part, 'base64url'),
    );

    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      iv,
    );

    decipher.setAAD(Buffer.from(userId));
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf8');
  }
}