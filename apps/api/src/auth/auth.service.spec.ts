
import {
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';

import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;

  const prisma = {
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  const jwt = {
    signAsync: jest.fn(),
  };

  beforeEach(() => {
    jest.resetAllMocks();

    service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as JwtService,
    );
  });

  // TEST 1: Register with a hashed password
  it('registers a user with an Argon2id hashed password', async () => {
    const user = {
      id: 'user-1',
      username: 'listener',
      email: 'listener@example.com',
      displayName: 'Listener',
      createdAt: new Date(),
    };

    prisma.user.create.mockResolvedValue(user);

    const result = await service.register({
      username: 'Listener',
      email: 'LISTENER@example.com',
      password: 'StrongPassword#12345',
      displayName: 'Listener',
    });

    const createArgs = prisma.user.create.mock.calls[0][0];

    expect(createArgs.data.username).toBe('listener');
    expect(createArgs.data.email).toBe(
      'listener@example.com',
    );

    expect(createArgs.data.passwordHash).toMatch(
      /^\$argon2id\$/,
    );

    expect(createArgs.data.passwordHash).not.toBe(
      'StrongPassword#12345',
    );

    expect(result.message).toBe('Registration successful');
    expect(result.user).not.toHaveProperty('passwordHash');
  });

  // TEST 2: Reject duplicate users
  it('rejects duplicate usernames or emails', async () => {
    prisma.user.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        {
          code: 'P2002',
          clientVersion: '7.10.1',
        },
      ),
    );

    await expect(
      service.register({
        username: 'listener',
        email: 'listener@example.com',
        password: 'StrongPassword#12345',
      }),
    ).rejects.toThrow(ConflictException);
  });

  // TEST 3: Successful login
  it('logs in with the correct password', async () => {
    const hash = await argon2.hash(
      'StrongPassword#12345',
      { type: argon2.argon2id },
    );

    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      username: 'listener',
      email: 'listener@example.com',
      displayName: 'Listener',
      passwordHash: hash,
    });

    jwt.signAsync.mockResolvedValue('test-jwt-token');

    const result = await service.login({
      email: 'listener@example.com',
      password: 'StrongPassword#12345',
    });

    expect(result.message).toBe('Login successful');
    expect(result.accessToken).toBe('test-jwt-token');
    expect(result.tokenType).toBe('Bearer');

    expect(result.user).not.toHaveProperty('passwordHash');

    expect(jwt.signAsync).toHaveBeenCalledWith({
      sub: 'user-1',
    });
  });

  // TEST 4: Incorrect password
  it('rejects an incorrect password', async () => {
    const hash = await argon2.hash(
      'CorrectPassword#12345',
      { type: argon2.argon2id },
    );

    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'listener@example.com',
      passwordHash: hash,
    });

    await expect(
      service.login({
        email: 'listener@example.com',
        password: 'WrongPassword#12345',
      }),
    ).rejects.toThrow(UnauthorizedException);

    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  // TEST 5: Unknown user
  it('rejects login for an unknown user', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.login({
        email: 'unknown@example.com',
        password: 'StrongPassword#12345',
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  // TEST 6: Retrieve authenticated profile
  it('retrieves the authenticated user profile', async () => {
    const user = {
      id: 'user-1',
      username: 'listener',
      email: 'listener@example.com',
      displayName: 'Listener',
      createdAt: new Date(),
    };

    prisma.user.findUnique.mockResolvedValue(user);

    const result = await service.me('user-1');

    expect(result).toEqual(user);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: {
        id: true,
        username: true,
        email: true,
        displayName: true,
        createdAt: true,
      },
    });
  });

  // TEST 7: Deleted user account
  it('rejects a deleted user account', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.me('missing-user'),
    ).rejects.toThrow(UnauthorizedException);
  });
});
