import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SpotifyService } from './spotify.service';

const NOW = new Date('2026-11-28T00:00:00Z');
const KEY = 'ab'.repeat(32);
const STATE = 'cd'.repeat(32);
const STATE_ID = createHash('sha256').update(STATE).digest('hex');
const USER_ID = 'listener-1';
const SETTINGS = {
  SPOTIFY_CLIENT_ID: 'test-client',
  SPOTIFY_CLIENT_SECRET: 'test-client-secret',
  SPOTIFY_REDIRECT_URI: 'http://127.0.0.1:4000/spotify/callback',
  SPOTIFY_TOKEN_ENCRYPTION_KEY: KEY,
};

// Build real authenticated ciphertext so sync exercises token decryption.
function encrypted(value: string, userId = USER_ID) {
  const iv = Buffer.alloc(12, 1);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), iv);
  cipher.setAAD(Buffer.from(userId));
  const bytes = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), bytes]
    .map((part) => part.toString('base64url'))
    .join('.');
}

function decrypted(value: string, userId = USER_ID) {
  const [iv, tag, bytes] = value
    .split('.')
    .map((part) => Buffer.from(part, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', Buffer.from(KEY, 'hex'), iv);
  cipher.setAAD(Buffer.from(userId));
  cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(bytes), cipher.final()]).toString('utf8');
}

function connection(overrides = {}) {
  return {
    id: 'connection-1',
    userId: USER_ID,
    spotifyAccountId: 'spotify-account-1',
    displayName: 'Listener',
    accessTokenEncrypted: encrypted('old-access'),
    refreshTokenEncrypted: encrypted('old-refresh'),
    expiresAt: new Date(NOW.getTime() + 3_600_000),
    scope: 'user-read-private user-top-read',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function prismaError(code: string) {
  return new Prisma.PrismaClientKnownRequestError('Test database constraint', {
    code,
    clientVersion: '7.10.1',
  });
}

describe('SpotifyService', () => {
  const prisma = {
    user: { findUnique: jest.fn() },
    spotifyOAuthState: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    spotifyConnection: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    spotifyTasteProfile: { findFirst: jest.fn(), upsert: jest.fn() },
    $transaction: jest.fn(),
  };
  let service: SpotifyService;
  let fetchMock: jest.SpiedFunction<typeof fetch>;

  function reply(body: unknown, status = 200, headers = {}) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status, headers }),
    );
  }

  function authorize() {
    reply({
      access_token: 'new-access',
      refresh_token: 'new-refresh',
      expires_in: 3600,
      scope: 'user-top-read',
    });
    reply({ account_id: 'spotify-account-1', display_name: 'Listener' });
    return service.callback(STATE, STATE, 'authorization-code', undefined);
  }

  function topItems() {
    reply({
      items: [
        { id: 'artist-1', name: 'Artist', images: [{ url: 'artist.jpg' }] },
      ],
    });
    reply({
      items: [
        {
          id: 'track-1',
          name: 'Song',
          artists: [{ id: 'artist-1', name: 'Artist' }],
          album: { images: [{ url: 'album.jpg' }] },
        },
        { id: null, name: 'Unavailable song', artists: [] },
      ],
    });
  }

  beforeEach(() => {
    jest.resetAllMocks();
    jest.useFakeTimers().setSystemTime(NOW);
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('Unexpected Spotify request in unit test'));
    service = new SpotifyService(
      prisma as unknown as PrismaService,
      new ConfigService(SETTINGS),
    );
    prisma.$transaction.mockImplementation(
      (run: (tx: typeof prisma) => Promise<unknown>) => run(prisma),
    );
    prisma.user.findUnique.mockResolvedValue({ id: USER_ID });
    prisma.spotifyOAuthState.findUnique.mockResolvedValue({
      id: STATE_ID,
      userId: USER_ID,
      expiresAt: new Date(NOW.getTime() + 600_000),
      consumedAt: null,
    });
    prisma.spotifyOAuthState.updateMany.mockResolvedValue({ count: 1 });
    prisma.spotifyOAuthState.deleteMany.mockResolvedValue({ count: 1 });
    prisma.spotifyConnection.findUnique.mockResolvedValue(connection());
    prisma.spotifyConnection.updateMany.mockResolvedValue({ count: 1 });
    prisma.spotifyTasteProfile.findFirst.mockResolvedValue({
      timeRange: 'medium_term',
      fetchedAt: NOW,
      artists: [],
      tracks: [],
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  describe('configuration', () => {
    it('rejects an invalid encryption key', () => {
      expect(
        () =>
          new SpotifyService(
            prisma as unknown as PrismaService,
            new ConfigService({
              ...SETTINGS,
              SPOTIFY_TOKEN_ENCRYPTION_KEY: 'too-short',
            }),
          ),
      ).toThrow('64 hex characters');
    });

    it.each([
      'http://example.com/spotify/callback',
      'http://localhost:4000/spotify/callback',
      'https://example.com/other',
      'https://example.com/spotify/callback?query=1',
      'https://example.com/spotify/callback#fragment',
      'https://user:password@example.com/spotify/callback',
    ])('rejects unsafe redirect URI %s', (uri) => {
      expect(
        () =>
          new SpotifyService(
            prisma as unknown as PrismaService,
            new ConfigService({ ...SETTINGS, SPOTIFY_REDIRECT_URI: uri }),
          ),
      ).toThrow('redirect URI');
    });
  });

  describe('OAuth', () => {
    it('stores a hash of a short-lived state and requests top-item permissions', async () => {
      const result = await service.connect(USER_ID);
      const url = new URL(result.authorizationUrl);
      expect(result.state).toMatch(/^[a-f0-9]{64}$/);
      expect(url.origin + url.pathname).toBe(
        'https://accounts.spotify.com/authorize',
      );
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: 'test-client',
        redirect_uri: SETTINGS.SPOTIFY_REDIRECT_URI,
        response_type: 'code',
        scope: 'user-read-private user-top-read',
        state: result.state,
      });
      expect(prisma.spotifyOAuthState.create).toHaveBeenCalledWith({
        data: {
          id: createHash('sha256').update(result.state).digest('hex'),
          userId: USER_ID,
          expiresAt: new Date(NOW.getTime() + 600_000),
        },
      });
      expect(prisma.spotifyOAuthState.deleteMany).toHaveBeenCalledWith({
        where: {
          OR: [{ userId: USER_ID }, { expiresAt: { lte: NOW } }],
        },
      });
    });

    it('rejects connecting a deleted Resonance user', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      await expect(service.connect(USER_ID)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it.each([
      [undefined, STATE],
      [['not-a-string'], STATE],
      [STATE, ''],
      [STATE, 'ef'.repeat(32)],
    ])(
      'rejects malformed or mismatched state before database access',
      async (state, cookie) => {
        await expect(
          service.callback(state, cookie as string, 'code', undefined),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.spotifyOAuthState.findUnique).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('rejects a missing state', async () => {
      prisma.spotifyOAuthState.findUnique.mockResolvedValue(null);
      await expect(
        service.callback(STATE, STATE, 'code', undefined),
      ).rejects.toThrow('already used or missing');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('atomically claims an unexpired, unused state before exchanging a code', async () => {
      prisma.spotifyOAuthState.updateMany.mockResolvedValue({ count: 0 });
      await expect(
        service.callback(STATE, STATE, 'code', undefined),
      ).rejects.toThrow('expired or already used');
      expect(prisma.spotifyOAuthState.updateMany).toHaveBeenCalledWith({
        where: { id: STATE_ID, expiresAt: { gt: NOW }, consumedAt: null },
        data: { consumedAt: NOW },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('cleans up a cancelled authorization without exchanging a code', async () => {
      await expect(
        service.callback(STATE, STATE, undefined, 'access_denied'),
      ).rejects.toThrow('authorization was cancelled');
      expect(prisma.spotifyOAuthState.deleteMany).toHaveBeenCalledWith({
        where: { id: STATE_ID },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([undefined, '', 'x'.repeat(4097)])(
      'rejects a missing or oversized code',
      async (code) => {
        await expect(
          service.callback(STATE, STATE, code, undefined),
        ).rejects.toThrow('authorization code');
        expect(fetchMock).not.toHaveBeenCalled();
      },
    );

    it('links the stable Spotify account and encrypts tokens bound to the owner', async () => {
      await expect(authorize()).resolves.toEqual({ connected: true });
      const { data } = prisma.spotifyConnection.create.mock.calls[0][0];
      expect(data).toMatchObject({
        userId: USER_ID,
        spotifyAccountId: 'spotify-account-1',
        displayName: 'Listener',
        expiresAt: new Date(NOW.getTime() + 3_600_000),
      });
      expect(data.accessTokenEncrypted).not.toContain('new-access');
      expect(data.refreshTokenEncrypted).not.toContain('new-refresh');
      expect(decrypted(data.accessTokenEncrypted)).toBe('new-access');
      expect(decrypted(data.refreshTokenEncrypted)).toBe('new-refresh');
      expect(() =>
        decrypted(data.accessTokenEncrypted, 'different-user'),
      ).toThrow();
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'https://accounts.spotify.com/api/token',
        expect.objectContaining({
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: 'authorization-code',
            redirect_uri: SETTINGS.SPOTIFY_REDIRECT_URI,
          }).toString(),
        }),
      );
    });

    it.each([
      { access_token: 'token', expires_in: 3600, scope: 'user-top-read' },
      {
        access_token: 'token',
        refresh_token: 'refresh',
        expires_in: 3600,
        scope: 'user-read-private',
      },
    ])('rejects incomplete token permissions', async (tokens) => {
      reply(tokens);
      await expect(
        service.callback(STATE, STATE, 'code', undefined),
      ).rejects.toThrow('required permissions');
      expect(prisma.spotifyConnection.create).not.toHaveBeenCalled();
    });

    it('rejects a profile without a stable account ID', async () => {
      reply({
        access_token: 'access',
        refresh_token: 'refresh',
        expires_in: 3600,
        scope: 'user-top-read',
      });
      reply({ display_name: 'Listener' });
      await expect(
        service.callback(STATE, STATE, 'code', undefined),
      ).rejects.toThrow(BadGatewayException);
      expect(prisma.spotifyConnection.create).not.toHaveBeenCalled();
    });

    it('does not relink after the pending connection was cancelled', async () => {
      prisma.spotifyOAuthState.deleteMany.mockResolvedValue({ count: 0 });
      await expect(authorize()).rejects.toThrow(
        'Connection request was cancelled',
      );
      expect(prisma.spotifyConnection.create).not.toHaveBeenCalled();
    });

    it('reports an account already linked to another Resonance user', async () => {
      prisma.spotifyConnection.create.mockRejectedValue(prismaError('P2002'));
      await expect(authorize()).rejects.toThrow(ConflictException);
    });
  });

  describe('saved profiles', () => {
    it('reports a disconnected account', async () => {
      prisma.spotifyConnection.findUnique.mockResolvedValue(null);
      await expect(service.status(USER_ID)).resolves.toEqual({
        connected: false,
      });
    });

    it('selects only public connection details for status', async () => {
      const safe = { displayName: 'Listener', createdAt: NOW, profiles: [] };
      prisma.spotifyConnection.findUnique.mockResolvedValue(safe);
      await expect(service.status(USER_ID)).resolves.toEqual({
        connected: true,
        ...safe,
      });
      expect(prisma.spotifyConnection.findUnique).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        select: {
          displayName: true,
          createdAt: true,
          profiles: { select: { timeRange: true, fetchedAt: true } },
        },
      });
    });

    it('scopes saved-profile reads to the owner and time range without contacting Spotify', async () => {
      await service.profile(USER_ID, 'long_term');
      expect(prisma.spotifyTasteProfile.findFirst).toHaveBeenCalledWith({
        where: { connection: { userId: USER_ID }, timeRange: 'long_term' },
        select: {
          timeRange: true,
          fetchedAt: true,
          artists: true,
          tracks: true,
        },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reports a missing saved profile', async () => {
      prisma.spotifyTasteProfile.findFirst.mockResolvedValue(null);
      await expect(service.profile(USER_ID, 'short_term')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('deletes pending OAuth requests and the connection in one transaction', async () => {
      await expect(service.disconnect(USER_ID)).resolves.toEqual({
        connected: false,
      });
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.spotifyOAuthState.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
      });
      expect(prisma.spotifyConnection.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('sync and refresh', () => {
    it('requires a connection before calling Spotify', async () => {
      prisma.spotifyConnection.findUnique.mockResolvedValue(null);
      await expect(service.sync(USER_ID, 'medium_term')).rejects.toThrow(
        'Connect Spotify first',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('requests the chosen range and persists ranked, normalized top items', async () => {
      topItems();
      const result = await service.sync(USER_ID, 'medium_term');
      const expected = {
        artists: [
          {
            rank: 1,
            spotifyId: 'artist-1',
            name: 'Artist',
            imageUrl: 'artist.jpg',
            spotifyUrl: 'https://open.spotify.com/artist/artist-1',
          },
        ],
        tracks: [
          {
            rank: 1,
            spotifyId: 'track-1',
            name: 'Song',
            artists: [{ spotifyId: 'artist-1', name: 'Artist' }],
            imageUrl: 'album.jpg',
            spotifyUrl: 'https://open.spotify.com/track/track-1',
          },
        ],
        fetchedAt: NOW,
      };
      expect(prisma.spotifyTasteProfile.upsert).toHaveBeenCalledWith({
        where: {
          connectionId_timeRange: {
            connectionId: 'connection-1',
            timeRange: 'medium_term',
          },
        },
        create: {
          connectionId: 'connection-1',
          timeRange: 'medium_term',
          ...expected,
        },
        update: expected,
      });
      expect(result).toEqual(await service.profile(USER_ID, 'medium_term'));
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'https://api.spotify.com/v1/me/top/artists?time_range=medium_term&limit=50',
        expect.objectContaining({
          headers: { Authorization: 'Bearer old-access' },
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        'https://api.spotify.com/v1/me/top/tracks?time_range=medium_term&limit=50',
        expect.anything(),
      );
    });

    it('refreshes an expired access token and preserves an unrotated refresh token', async () => {
      const expired = connection({ expiresAt: NOW });
      prisma.spotifyConnection.findUnique
        .mockResolvedValueOnce(expired)
        .mockResolvedValueOnce(expired)
        .mockResolvedValueOnce(
          connection({ accessTokenEncrypted: encrypted('new-access') }),
        );
      reply({ access_token: 'new-access', expires_in: 3600 });
      topItems();
      await service.sync(USER_ID, 'short_term');
      const { where, data } =
        prisma.spotifyConnection.updateMany.mock.calls[0][0];
      expect(where).toEqual({
        id: expired.id,
        accessTokenEncrypted: expired.accessTokenEncrypted,
      });
      expect(decrypted(data.accessTokenEncrypted)).toBe('new-access');
      expect(data.refreshTokenEncrypted).toBe(expired.refreshTokenEncrypted);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        'https://accounts.spotify.com/api/token',
        expect.objectContaining({
          body: 'grant_type=refresh_token&refresh_token=old-refresh',
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('/me/top/artists'),
        expect.objectContaining({
          headers: { Authorization: 'Bearer new-access' },
        }),
      );
    });

    it('stores a rotated refresh token', async () => {
      const expired = connection({ expiresAt: NOW });
      prisma.spotifyConnection.findUnique
        .mockResolvedValueOnce(expired)
        .mockResolvedValueOnce(expired)
        .mockResolvedValueOnce(
          connection({ accessTokenEncrypted: encrypted('new-access') }),
        );
      reply({
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
        expires_in: 3600,
      });
      topItems();
      await service.sync(USER_ID, 'medium_term');
      expect(
        decrypted(
          prisma.spotifyConnection.updateMany.mock.calls[0][0].data
            .refreshTokenEncrypted,
        ),
      ).toBe('rotated-refresh');
    });

    it('deduplicates simultaneous refreshes within this service instance', async () => {
      const expired = connection({ expiresAt: NOW });
      const refreshed = connection({
        accessTokenEncrypted: encrypted('new-access'),
      });
      prisma.spotifyConnection.findUnique
        .mockResolvedValueOnce(expired)
        .mockResolvedValueOnce(expired)
        .mockResolvedValueOnce(expired)
        .mockResolvedValueOnce(refreshed);
      reply({ access_token: 'new-access', expires_in: 3600 });
      topItems();
      topItems();
      await Promise.all([
        service.sync(USER_ID, 'short_term'),
        service.sync(USER_ID, 'long_term'),
      ]);
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          String(url).includes('/api/token'),
        ),
      ).toHaveLength(1);
      expect(prisma.spotifyConnection.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.spotifyTasteProfile.upsert).toHaveBeenCalledTimes(2);
    });

    it('refreshes after a 401 and retries the top-item requests once', async () => {
      reply({ error: { status: 401 } }, 401);
      reply({ items: [] });
      reply({ access_token: 'new-access', expires_in: 3600 });
      topItems();
      await service.sync(USER_ID, 'medium_term');
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(prisma.spotifyConnection.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.spotifyTasteProfile.upsert).toHaveBeenCalledTimes(1);
    });

    it('stops after a second 401 without persisting a failed sync', async () => {
      reply({}, 401);
      reply({ items: [] });
      reply({ access_token: 'new-access', expires_in: 3600 });
      reply({}, 401);
      reply({ items: [] });
      await expect(service.sync(USER_ID, 'medium_term')).rejects.toThrow(
        UnauthorizedException,
      );
      expect(fetchMock).toHaveBeenCalledTimes(5);
      expect(prisma.spotifyTasteProfile.upsert).not.toHaveBeenCalled();
    });

    it('removes a revoked connection and asks the client to reconnect', async () => {
      prisma.spotifyConnection.findUnique.mockResolvedValue(
        connection({ expiresAt: NOW }),
      );
      reply({ error: 'invalid_grant' }, 400);
      await expect(service.sync(USER_ID, 'medium_term')).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'SPOTIFY_RECONNECT_REQUIRED',
        }),
      });
      expect(prisma.spotifyConnection.deleteMany).toHaveBeenCalledWith({
        where: {
          id: 'connection-1',
          accessTokenEncrypted: encrypted('old-access'),
        },
      });
      expect(prisma.spotifyTasteProfile.upsert).not.toHaveBeenCalled();
    });

    it('does not overwrite saved data when Spotify returns invalid top items', async () => {
      reply({ items: null });
      reply({ items: [] });
      await expect(service.sync(USER_ID, 'medium_term')).rejects.toThrow(
        BadGatewayException,
      );
      expect(prisma.spotifyTasteProfile.upsert).not.toHaveBeenCalled();
    });

    it('reports a connection removed while syncing', async () => {
      topItems();
      prisma.spotifyTasteProfile.upsert.mockRejectedValue(prismaError('P2003'));
      await expect(service.sync(USER_ID, 'medium_term')).rejects.toThrow(
        'connection changed',
      );
    });
  });

  describe('Spotify failures', () => {
    it.each([
      [403, ForbiddenException],
      [500, BadGatewayException],
    ])(
      'maps upstream HTTP %s without writing a profile',
      async (status, exception) => {
        reply({}, status);
        reply({ items: [] });
        await expect(service.sync(USER_ID, 'medium_term')).rejects.toThrow(
          exception,
        );
        expect(prisma.spotifyTasteProfile.upsert).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['12', 12],
      ['invalid', null],
      ['-1', null],
    ])('handles Retry-After %s on rate limits', async (header, expected) => {
      reply({}, 429, { 'Retry-After': header });
      reply({ items: [] });
      try {
        await service.sync(USER_ID, 'medium_term');
        throw new Error('Expected a rate-limit error');
      } catch (error) {
        expect(error).toBeInstanceOf(HttpException);
        expect((error as HttpException).getStatus()).toBe(429);
        expect((error as HttpException).getResponse()).toEqual({
          message: 'Spotify request limit reached',
          retryAfterSeconds: expected,
        });
      }
      expect(prisma.spotifyTasteProfile.upsert).not.toHaveBeenCalled();
    });

    it('maps fetch failures to temporary unavailability', async () => {
      fetchMock.mockRejectedValue(new Error('Network failure'));
      await expect(service.sync(USER_ID, 'medium_term')).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(prisma.spotifyTasteProfile.upsert).not.toHaveBeenCalled();
    });

    it('rejects malformed JSON', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response('not-json', { status: 200 }),
      );
      reply({ items: [] });
      await expect(service.sync(USER_ID, 'medium_term')).rejects.toThrow(
        BadGatewayException,
      );
      expect(prisma.spotifyTasteProfile.upsert).not.toHaveBeenCalled();
    });

    it.each([
      { access_token: '', expires_in: 3600 },
      { access_token: 'token', expires_in: 0 },
      { access_token: 'token', expires_in: '3600' },
      { access_token: 'token', expires_in: 3600, refresh_token: '' },
      { access_token: 'token', expires_in: 3600, scope: [] },
    ])(
      'rejects invalid token data without linking an account',
      async (tokens) => {
        reply(tokens);
        await expect(
          service.callback(STATE, STATE, 'code', undefined),
        ).rejects.toThrow(BadGatewayException);
        expect(prisma.spotifyConnection.create).not.toHaveBeenCalled();
      },
    );
  });
});
