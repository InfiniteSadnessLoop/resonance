
import {
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

import { JwtAuthGuard } from './jwt-auth.guard';

describe('JwtAuthGuard', () => {
  const jwt = {
    verifyAsync: jest.fn(),
  };

  let guard: JwtAuthGuard;

  function createContext(authorization?: string) {
    const request = {
      headers: {
        authorization,
      },
      user: undefined as { id: string } | undefined,
    };

    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;

    return { context, request };
  }

  beforeEach(() => {
    jest.resetAllMocks();

    guard = new JwtAuthGuard(
      jwt as unknown as JwtService,
    );
  });

  // TEST 1: Missing token
  it('rejects requests without an access token', async () => {
    const { context } = createContext();

    await expect(
      guard.canActivate(context),
    ).rejects.toThrow(UnauthorizedException);
  });

  // TEST 2: Invalid token
  it('rejects invalid access tokens', async () => {
    const { context } = createContext(
      'Bearer invalid-token',
    );

    jwt.verifyAsync.mockRejectedValue(
      new Error('Invalid signature'),
    );

    await expect(
      guard.canActivate(context),
    ).rejects.toThrow(UnauthorizedException);
  });

  // TEST 3: Missing user ID
  it('rejects tokens without a valid subject', async () => {
    const { context } = createContext(
      'Bearer test-token',
    );

    jwt.verifyAsync.mockResolvedValue({});

    await expect(
      guard.canActivate(context),
    ).rejects.toThrow(UnauthorizedException);
  });

  // TEST 4: Valid token
  it('accepts a valid token and attaches the user ID', async () => {
    const { context, request } = createContext(
      'Bearer valid-token',
    );

    jwt.verifyAsync.mockResolvedValue({
      sub: 'user-1',
    });

    const allowed = await guard.canActivate(context);

    expect(allowed).toBe(true);

    expect(request.user).toEqual({
      id: 'user-1',
    });

    expect(jwt.verifyAsync).toHaveBeenCalledWith(
      'valid-token',
    );
  });
});
