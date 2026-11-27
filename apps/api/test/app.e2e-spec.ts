import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SpotifyService } from '../src/spotify/spotify.service';

// Exercise real routes, JWT verification, validation, and throttling.
// Unit tests cover the real Spotify service separately.
describe('API (HTTP)', () => {
  let app: INestApplication<App>;
  let token: string;
  const state = 'ab'.repeat(32);
  const spotify = {
    redirectUri: 'http://127.0.0.1:4000/spotify/callback',
    connect: jest.fn(),
    callback: jest.fn(),
    status: jest.fn(),
    profile: jest.fn(),
    sync: jest.fn(),
    disconnect: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetAllMocks();
    spotify.connect.mockResolvedValue({
      state,
      authorizationUrl: 'https://accounts.spotify.com/authorize',
    });
    spotify.callback.mockResolvedValue({ connected: true });
    spotify.status.mockResolvedValue({ connected: false });
    spotify.profile.mockResolvedValue({
      timeRange: 'medium_term',
      artists: [],
      tracks: [],
    });
    spotify.sync.mockResolvedValue({
      timeRange: 'medium_term',
      artists: [],
      tracks: [],
    });
    spotify.disconnect.mockResolvedValue({ connected: false });
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(SpotifyService)
      .useValue(spotify)
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          JWT_ACCESS_SECRET: 'test-only-jwt-secret-at-least-32-bytes-long',
        }),
      )
      .compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
    token = await module.get(JwtService).signAsync({ sub: 'listener-1' });
  });

  afterEach(async () => {
    await app?.close();
  });

  it('serves the application health response without a live database', async () => {
    await request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  it.each([
    ['post', '/spotify/connect'],
    ['get', '/spotify/status'],
    ['get', '/spotify/taste'],
    ['post', '/spotify/sync'],
    ['delete', '/spotify/disconnect'],
  ] as const)('requires a JWT for %s %s', async (method, path) => {
    await request(app.getHttpServer())[method](path).expect(401);
    for (const method of [
      'connect',
      'status',
      'profile',
      'sync',
      'disconnect',
    ] as const) {
      expect(spotify[method]).not.toHaveBeenCalled();
    }
  });

  it('rejects an invalid JWT', async () => {
    await request(app.getHttpServer())
      .get('/spotify/status')
      .auth('invalid-token', { type: 'bearer' })
      .expect(401);
    expect(spotify.status).not.toHaveBeenCalled();
  });

  it('returns an authorization URL and a scoped HTTP-only state cookie', async () => {
    const response = await request(app.getHttpServer())
      .post('/spotify/connect')
      .auth(token, { type: 'bearer' })
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(response.body).toEqual({
      authorizationUrl: 'https://accounts.spotify.com/authorize',
    });
    expect(spotify.connect).toHaveBeenCalledWith('listener-1');
    const cookie = response.headers['set-cookie'][0];
    expect(cookie).toContain(`resonance_spotify_state=${state}`);
    expect(cookie).toMatch(/Path=\/spotify\/callback/);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
    expect(cookie).not.toMatch(/; Secure/);
  });

  it('marks state cookies secure with an HTTPS redirect', async () => {
    const original = spotify.redirectUri;
    try {
      spotify.redirectUri = 'https://example.com/spotify/callback';
      const response = await request(app.getHttpServer())
        .post('/spotify/connect')
        .auth(token, { type: 'bearer' })
        .expect(200);
      expect(response.headers['set-cookie'][0]).toMatch(/; Secure/);
    } finally {
      spotify.redirectUri = original;
    }
  });

  it('limits connection attempts to three per minute', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await request(app.getHttpServer())
        .post('/spotify/connect')
        .auth(token, { type: 'bearer' })
        .expect(200);
    }
    await request(app.getHttpServer())
      .post('/spotify/connect')
      .auth(token, { type: 'bearer' })
      .expect(429);
    expect(spotify.connect).toHaveBeenCalledTimes(3);
  });

  it('passes callback state and cookie to the service and clears the cookie', async () => {
    const response = await request(app.getHttpServer())
      .get('/spotify/callback')
      .query({ state, code: 'test-code' })
      .set('Cookie', `other=value; resonance_spotify_state=${state}`)
      .expect(200)
      .expect('Content-Type', /html/)
      .expect('Cache-Control', 'no-store')
      .expect('Referrer-Policy', 'no-referrer');
    expect(spotify.callback).toHaveBeenCalledWith(
      state,
      state,
      'test-code',
      undefined,
    );
    expect(response.headers['set-cookie'][0]).toMatch(
      /resonance_spotify_state=;/,
    );
    expect(response.text).toContain('Spotify connected');
  });

  it('returns status for the authenticated owner', async () => {
    await request(app.getHttpServer())
      .get('/spotify/status')
      .auth(token, { type: 'bearer' })
      .expect(200)
      .expect({ connected: false });
    expect(spotify.status).toHaveBeenCalledWith('listener-1');
  });

  it('defaults saved-profile reads to medium_term', async () => {
    await request(app.getHttpServer())
      .get('/spotify/taste')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(spotify.profile).toHaveBeenCalledWith('listener-1', 'medium_term');
  });

  it.each(['short_term', 'medium_term', 'long_term'])(
    'accepts sync range %s',
    async (timeRange) => {
      await request(app.getHttpServer())
        .post('/spotify/sync')
        .auth(token, { type: 'bearer' })
        .send({ timeRange })
        .expect(200);
      expect(spotify.sync).toHaveBeenCalledWith('listener-1', timeRange);
    },
  );

  it('defaults an empty sync body to medium_term', async () => {
    await request(app.getHttpServer())
      .post('/spotify/sync')
      .auth(token, { type: 'bearer' })
      .send({})
      .expect(200);
    expect(spotify.sync).toHaveBeenCalledWith('listener-1', 'medium_term');
  });

  it.each([
    { timeRange: 'forever' },
    { timeRange: ['short_term'] },
    { timeRange: 'short_term', userId: 'different-user' },
  ])('rejects invalid sync bodies before calling the service', async (body) => {
    await request(app.getHttpServer())
      .post('/spotify/sync')
      .auth(token, { type: 'bearer' })
      .send(body)
      .expect(400);
    expect(spotify.sync).not.toHaveBeenCalled();
  });

  it('rejects invalid taste query ranges', async () => {
    await request(app.getHttpServer())
      .get('/spotify/taste?timeRange=forever')
      .auth(token, { type: 'bearer' })
      .expect(400);
    expect(spotify.profile).not.toHaveBeenCalled();
  });

  it('disconnects the authenticated owner and clears the state cookie', async () => {
    const response = await request(app.getHttpServer())
      .delete('/spotify/disconnect')
      .auth(token, { type: 'bearer' })
      .expect(200)
      .expect({ connected: false });
    expect(spotify.disconnect).toHaveBeenCalledWith('listener-1');
    expect(response.headers['set-cookie'][0]).toMatch(
      /resonance_spotify_state=;/,
    );
  });

  it('hides the manual test page outside development', async () => {
    const original = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'test';
      await request(app.getHttpServer()).get('/spotify/test').expect(404);
    } finally {
      if (original === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = original;
    }
  });
});
