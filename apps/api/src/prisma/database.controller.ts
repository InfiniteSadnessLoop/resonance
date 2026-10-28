
import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Controller('health')
export class DatabaseController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('db')
  async checkDatabase() {
    const users = await this.prisma.user.count();

    return {
      status: 'ok',
      database: 'connected',
      users,
    };
  }
}
