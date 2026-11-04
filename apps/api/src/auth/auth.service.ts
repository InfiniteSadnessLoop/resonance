
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';

import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  // Register a new user
  async register(dto: RegisterDto) {
    const passwordHash = await argon2.hash(dto.password, {
      type: argon2.argon2id,
    });

    try {
      const user = await this.prisma.user.create({
        data: {
          username: dto.username.toLowerCase(),
          email: dto.email.toLowerCase(),
          displayName: dto.displayName,
          passwordHash,
        },
        select: {
          id: true,
          username: true,
          email: true,
          displayName: true,
          createdAt: true,
        },
      });

      return {
        message: 'Registration successful',
        user,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          'Username or email already exists',
        );
      }

      throw error;
    }
  }

  // Log in an existing user
  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: {
        email: dto.email.trim().toLowerCase(),
      },
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        passwordHash: true,
      },
    });

    if (!user?.passwordHash) {
      throw new UnauthorizedException(
        'Invalid email or password',
      );
    }

    const passwordMatches = await argon2.verify(
      user.passwordHash,
      dto.password,
    );

    if (!passwordMatches) {
      throw new UnauthorizedException(
        'Invalid email or password',
      );
    }

    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
    });

    return {
      message: 'Login successful',
      accessToken,
      tokenType: 'Bearer',
      expiresIn: 900,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
      },
    };
  }

  // Retrieve the authenticated user's profile
  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: {
        id: userId,
      },
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        createdAt: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException(
        'User account no longer exists',
      );
    }

    return user;
  }
}
