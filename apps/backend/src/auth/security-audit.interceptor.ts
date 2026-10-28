import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { from, type Observable } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { IS_PUBLIC_KEY } from './decorators';
import { SecurityAuditStore, type SecurityAuditEvent } from './security-audit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A route/handler name is static source metadata; never copy a request URL into audit evidence. */
function routeEvent(context: ExecutionContext, req: Request, type: SecurityAuditEvent['type'], outcome: SecurityAuditEvent['outcome']): SecurityAuditEvent {
  const controller = context.getClass().name;
  const handler = context.getHandler().name;
  const candidate: unknown = req.params?.id;
  return {
    type,
    outcome,
    tenantId: req.principal!.tenantId,
    actorSub: req.principal!.sub,
    routeKey: `${controller}.${handler}`,
    subjectId: typeof candidate === 'string' && UUID.test(candidate) ? candidate : null,
    requestId: String(req.id),
  };
}

export function accessEvent(context: ExecutionContext, req: Request, outcome: 'succeeded' | 'refused'): SecurityAuditEvent {
  const download = context.getClass().name === 'ReportsController' && context.getHandler().name === 'downloadUrl';
  return routeEvent(context, req, download ? 'download-link' : 'private-read', outcome);
}

/** A write is recorded before it runs: who asked to change what (the route and the id in its path), never what the change was. RolesGuard records one it refuses. */
export function writeEvent(context: ExecutionContext, req: Request, outcome: 'accepted' | 'refused' = 'accepted'): SecurityAuditEvent {
  return routeEvent(context, req, 'private-write', outcome);
}

export const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

@Injectable()
export class SecurityAuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: SecurityAuditStore,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    const req = context.switchToHttp().getRequest<Request>();
    if (isPublic || !req.principal) return next.handle();
    // The row is written FIRST and the handler runs only once it is stored: a write that cannot be recorded does not happen (the request answers 503 and nothing changed).
    // A read is written after the handler, as before, and a response is withheld if its row cannot be stored.
    if (WRITE_METHODS.has(req.method)) return from(this.audit.record(writeEvent(context, req))).pipe(mergeMap(() => next.handle()));
    if (req.method !== 'GET') return next.handle();
    return next.handle().pipe(
      catchError((error) =>
        from(
          this.audit.record(accessEvent(context, req, 'refused')).then(() => {
            throw error;
          }),
        ),
      ),
      mergeMap((value) => from(this.audit.record(accessEvent(context, req, 'succeeded')).then(() => value))),
    );
  }
}
