import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../../src/auth/decorators';
import { REQUIRES_PIPELINE, UNLOCKED_BY_SYNTHETIC_ASSESSMENT } from '../../src/lab-reports/pipeline-switch';

const HTTP = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL', 'OPTIONS', 'HEAD'];

/** Which switch must be on for the route to answer. `always` is a route no switch closes. */
export type RouteGate = 'always' | 'pipeline' | 'pipeline-or-synthetic-assessment' | 'synthetic-assessment';

export interface Route {
  /** `GET /api/v1/patients/:id`. */
  key: string;
  isPublic: boolean;
  /** As declared with `@Roles()`, on the handler or else its controller; undefined when neither declares any. */
  roles: unknown;
  gate: RouteGate;
}

/** Every route of the running application, read from the controllers Nest registered: a route cannot be missed by forgetting to list it. */
export function routeTable(app: NestExpressApplication): Route[] {
  const found: Route[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...a: never[]) => unknown) | null;
      if (!controller) continue;
      const base = Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined;
      const prefix = String(Array.isArray(base) ? base[0] : (base ?? '')).replace(/^\/|\/$/g, '');
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (method === undefined) continue;
        const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '').replace(/^\/|\/$/g, '');
        const verb = HTTP[method] ?? String(method);
        const marked = (key: string) => Reflect.getMetadata(key, handler) === true || Reflect.getMetadata(key, controller) === true;
        const pipeline = marked(REQUIRES_PIPELINE);
        const synthetic = marked(UNLOCKED_BY_SYNTHETIC_ASSESSMENT);
        found.push({
          key: `${verb} /api/v1/${[prefix, sub].filter(Boolean).join('/')}`,
          isPublic: marked(IS_PUBLIC_KEY),
          roles: Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, controller),
          gate: pipeline && synthetic ? 'pipeline-or-synthetic-assessment' : pipeline ? 'pipeline' : synthetic ? 'synthetic-assessment' : 'always',
        });
      }
    }
  }
  return found;
}
