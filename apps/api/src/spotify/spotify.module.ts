import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { SpotifyController } from './spotify.controller';
import { SpotifyService } from './spotify.service';

@Module({
  imports: [
    AuthModule,
    PrismaModule,
  ],
  controllers: [SpotifyController],
  providers: [SpotifyService],
})
export class SpotifyModule {}