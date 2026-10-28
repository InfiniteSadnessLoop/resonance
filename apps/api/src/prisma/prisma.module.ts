
import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { DatabaseController } from './database.controller';

@Module({
  controllers: [DatabaseController],
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
