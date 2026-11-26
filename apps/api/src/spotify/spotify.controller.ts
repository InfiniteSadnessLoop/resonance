import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type {
  CookieOptions,
  Request,
  Response,
} from 'express';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TasteQueryDto } from './spotify.dto';
import { SpotifyService } from './spotify.service';
import { SPOTIFY_TEST_PAGE } from './spotify.test-page';

type AuthRequest = Request & {
  user: { id: string };
};

const COOKIE = 'resonance_spotify_state';

@Controller('spotify')
export class SpotifyController {
  constructor(
    private readonly spotify: SpotifyService,
  ) {}

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      path: '/spotify/callback',
      secure:
        new URL(this.spotify.redirectUri).protocol ===
        'https:',
    };
  }

  @Get('test')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  testPage() {
    if (process.env.NODE_ENV !== 'development') {
      throw new NotFoundException();
    }

    return SPOTIFY_TEST_PAGE;
  }

  @Post('connect')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Throttle({
    default: { limit: 3, ttl: 60_000 },
  })
  @Header('Cache-Control', 'no-store')
  async connect(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.spotify.connect(
      req.user.id,
    );

    res.cookie(COOKIE, result.state, {
      ...this.cookieOptions(),
      maxAge: 600_000,
    });

    return {
      authorizationUrl: result.authorizationUrl,
    };
  }

  @Get('callback')
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  async callback(
    @Req() req: Request,
    @Query('state') state: unknown,
    @Query('code') code: unknown,
    @Query('error') error: unknown,
    @Res() res: Response,
  ) {
    const cookie =
      (req.headers.cookie ?? '')
        .split(';')
        .map((part) => part.trim())
        .find((part) =>
          part.startsWith(COOKIE + '='),
        )
        ?.slice(COOKIE.length + 1) ?? '';

    res.clearCookie(
      COOKIE,
      this.cookieOptions(),
    );

    await this.spotify.callback(
      state,
      cookie,
      code,
      error,
    );

    return res.type('html').send(
      '<!doctype html><html lang="en">' +
      '<meta charset="utf-8">' +
      '<title>Spotify connected</title>' +
      '<h1>Spotify connected</h1>' +
      '<p>Close this tab, return to Resonance, ' +
      'and click Sync.</p></html>',
    );
  }

  @Get('status')
  @UseGuards(JwtAuthGuard)
  @Header('Cache-Control', 'no-store')
  status(@Req() req: AuthRequest) {
    return this.spotify.status(req.user.id);
  }

  @Post('sync')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @Throttle({
    default: { limit: 3, ttl: 60_000 },
  })
  @Header('Cache-Control', 'no-store')
  sync(
    @Req() req: AuthRequest,
    @Body() dto: TasteQueryDto,
  ) {
    return this.spotify.sync(
      req.user.id,
      dto.timeRange,
    );
  }

  @Get('taste')
  @UseGuards(JwtAuthGuard)
  @Header('Cache-Control', 'no-store')
  taste(
    @Req() req: AuthRequest,
    @Query() dto: TasteQueryDto,
  ) {
    return this.spotify.profile(
      req.user.id,
      dto.timeRange,
    );
  }

  @Delete('disconnect')
  @UseGuards(JwtAuthGuard)
  @Header('Cache-Control', 'no-store')
  async disconnect(
    @Req() req: AuthRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.clearCookie(
      COOKIE,
      this.cookieOptions(),
    );

    return this.spotify.disconnect(req.user.id);
  }
}