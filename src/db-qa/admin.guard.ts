import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

/**
 * Combined JWT verification + admin role check guard.
 * Allows only ADMIN and SUPER_ADMIN roles (as set in pg-middleware user accounts).
 * JWT payload structure from pg-middleware: { data: { id, role, ... } }
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('No token provided');
    }

    if (this.config.get<string>('BYPASS_JWT_AUTH') === 'true') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (request as any).user = { bypass: true, data: { role: 'SUPER_ADMIN' } };
      return true;
    }

    let payload: Record<string, unknown>;
    try {
      payload = await this.jwtService.verifyAsync<Record<string, unknown>>(token, {
        secret: this.config.get<string>('JWT_SECRET'),
        algorithms: ['HS256'],
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (request as any).user = payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const data = payload?.data as Record<string, unknown> | undefined;
    const role = data?.role as string | undefined;
    if (role !== 'ADMIN' && role !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Admin access required');
    }

    return true;
  }

  private extractToken(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
