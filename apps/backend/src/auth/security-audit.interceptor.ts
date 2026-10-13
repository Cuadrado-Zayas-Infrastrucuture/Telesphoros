import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { from, type Observable } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { IS_PUBLIC_KEY } from './decorators';
import { SecurityAuditStore, type SecurityAuditEvent } from './security-audit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A route/handler name is static source metadata; never copy a request URL into audit evidence. */
export function accessEvent(context: ExecutionContext, req: Request, outcome: 'succeeded' | 'refused'): SecurityAuditEvent {
  const controller = context.getClass().name;
  const handler = context.getHandler().name;
  const candidate: unknown = req.params?.id;
  return {
    type: controller === 'ReportsController' && handler === 'downloadUrl' ? 'download-link' : 'private-read',
    outcome,
    tenantId: req.principal!.tenantId,
    actorSub: req.principal!.sub,
    routeKey: `${controller}.${handler}`,
    subjectId: typeof candidate === 'string' && UUID.test(candidate) ? candidate : null,
    requestId: String(req.id),
  };
}

@Injectable()
export class SecurityAuditInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector, private readonly audit: SecurityAuditStore) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    const req = context.switchToHttp().getRequest<Request>();
    if (isPublic || req.method !== 'GET' || !req.principal) return next.handle();
    return next.handle().pipe(
      catchError(error => from(this.audit.record(accessEvent(context, req, 'refused')).then(() => { throw error; }))),
      mergeMap(value => from(this.audit.record(accessEvent(context, req, 'succeeded')).then(() => value))),
    );
  }
}
