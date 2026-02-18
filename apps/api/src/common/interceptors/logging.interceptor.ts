import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { Request, Response } from 'express';

/**
 * Global interceptor that logs every HTTP request with method, path, status
 * code, and elapsed time. Errors are logged at the warn level.
 */
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const { method, url } = req;
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          const res = context.switchToHttp().getResponse<Response>();
          const ms = Date.now() - start;
          this.logger.log(`${method} ${url} → ${res.statusCode} (+${ms}ms)`);
        },
        error: (err: Error) => {
          const ms = Date.now() - start;
          this.logger.warn(`${method} ${url} → ERROR (+${ms}ms): ${err.message}`);
        },
      }),
    );
  }
}
