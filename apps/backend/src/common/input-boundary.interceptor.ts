import { RAW_INTAKE } from '../reports/intake/raw-intake';
import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import type { Request } from 'express';
import { LOG_ROUTE } from './log-route';
import { AppException } from './app-exception';

/**
 * The existing @Body/@Query parameter declarations are the input contract. Reject extra input on routes that
 * consume neither, after authentication/authorization and before pipes or business logic. A missing body or
 * empty JSON object is allowed on a bodyless action; arrays, null, primitives and nonempty objects are refused.
 * The controller inventory test pins Nest's parameter metadata and requires strict pipes on consumers.
 */
@Injectable()
export class InputBoundaryInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const args: Record<string, unknown> = Reflect.getMetadata(ROUTE_ARGS_METADATA, context.getClass(), context.getHandler().name) ?? {};
    const kinds = new Set(Object.keys(args).map((key) => key.split(':')[0]));
    const req = context.switchToHttp().getRequest<Request>();
    // Capture while Nest's matched route is active; the HTTP logger binds its request BEFORE routing.
    (req as Request & { [LOG_ROUTE]?: string })[LOG_ROUTE] = typeof req.route?.path === 'string' ? req.route.path : '[unmatched]';
    const framedBody = Number(req.headers?.['content-length'] ?? 0) > 0 || req.headers?.['transfer-encoding'] !== undefined;
    if (framedBody && req.body === undefined && !Reflect.getMetadata(RAW_INTAKE, context.getHandler())) {
      throw AppException.validation([
        {
          field: '(body)',
          message: 'A request body must use application/json.',
        },
      ]);
    }
    const emptyBody = req.body === undefined || (req.body !== null && typeof req.body === 'object' && !Array.isArray(req.body) && Object.keys(req.body).length === 0);
    if (!kinds.has(String(RouteParamtypes.BODY)) && !emptyBody) {
      throw AppException.validation([{ field: '(body)', message: 'This endpoint does not accept a body.' }]);
    }
    if (!kinds.has(String(RouteParamtypes.QUERY)) && Object.keys(req.query).length > 0) {
      throw AppException.validation([
        {
          field: '(query)',
          message: 'This endpoint does not accept query parameters.',
        },
      ]);
    }
    return next.handle();
  }
}
