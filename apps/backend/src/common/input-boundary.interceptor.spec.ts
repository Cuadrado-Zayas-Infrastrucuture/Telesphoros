import { type CallHandler, type ExecutionContext, type Type } from '@nestjs/common';
import { PATH_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { of } from 'rxjs';
import { PatientsController } from '../patients/patients.controller';
import { ReportsController } from '../reports/reports.controller';
import { CapturesController, ReportCaptureController } from '../lab-reports/captures.controller';
import { EvaluationsController, ReportEvaluationController } from '../lab-reports/evaluations.controller';
import { NotesController, EvaluationCorrectionsController } from '../lab-reports/corrections.controller';
import { DisputesController } from '../lab-reports/disputes.controller';
import { LedgerController } from '../ledger/ledger.controller';
import { HealthController } from '../health/health.controller';
import { MeController } from '../me/me.controller';
import { MembersController } from '../members/members.controller';
import { PatientIdentifiersController, PatientLinkQuarantineController, ReportPatientLinkController } from '../patient-identity/patient-identity.controller';
import { PatientDuplicatesController, PatientMergesController } from '../patient-merge/patient-merge.controller';
import { InputBoundaryInterceptor } from './input-boundary.interceptor';
import { ZodValidationPipe } from './zod-validation.pipe';

const controllers: Type[] = [
  PatientsController,
  ReportsController,
  CapturesController,
  ReportCaptureController,
  EvaluationsController,
  ReportEvaluationController,
  NotesController,
  EvaluationCorrectionsController,
  DisputesController,
  LedgerController,
  HealthController,
  MeController,
  MembersController,
  PatientIdentifiersController,
  ReportPatientLinkController,
  PatientLinkQuarantineController,
  PatientDuplicatesController,
  PatientMergesController,
];
const routes = controllers.flatMap((controller) =>
  Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor' && typeof controller.prototype[name] === 'function' && Reflect.hasMetadata(PATH_METADATA, controller.prototype[name]))
    .map((name) => ({
      controller,
      name,
      handler: controller.prototype[name] as () => unknown,
    })),
);

function context(controller: Type, handler: () => unknown, body: unknown, query: unknown): ExecutionContext {
  return {
    getClass: () => controller,
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => ({ body, query }) }),
  } as unknown as ExecutionContext;
}
const interceptor = new InputBoundaryInterceptor();

it('inventories every registered production controller and strict input pipe', () => {
  const source = resolve(__dirname, '..');
  const declared = readdirSync(source, { recursive: true })
    .filter((file) => String(file).endsWith('.controller.ts'))
    .flatMap((file) => [...readFileSync(resolve(source, String(file)), 'utf8').matchAll(/export class (\w+Controller)\b/g)].map((match) => match[1]));
  expect(controllers.map((c) => c.name).sort()).toEqual(declared.sort());
  expect(controllers).toHaveLength(18);
  expect(routes.length).toBeGreaterThan(30);
  for (const { controller, name } of routes) {
    const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {};
    for (const [key, value] of Object.entries(args)) {
      if ([String(RouteParamtypes.BODY), String(RouteParamtypes.QUERY), String(RouteParamtypes.PARAM)].includes(key.split(':')[0]!)) {
        expect((value as { pipes: unknown[] }).pipes.some((p) => p instanceof ZodValidationPipe)).toBe(true);
      }
    }
  }
});

it.each(routes.map((r) => [r.controller.name + '.' + r.name, r] as const))('%s refuses undeclared input before invoking the handler', (_label, { controller, name, handler }) => {
  const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, name) ?? {};
  const consumes = (kind: RouteParamtypes) => Object.keys(args).some((key) => key.startsWith(`${kind}:`));
  const next = { handle: jest.fn(() => of(null)) } as CallHandler;
  if (!consumes(RouteParamtypes.BODY)) {
    for (const body of [{ ignored: 'SYNTHETIC-PRIVATE' }, [], null, 'value', 1]) {
      expect(() => interceptor.intercept(context(controller, handler, body, {}), next)).toThrow('The request was not valid.');
    }
    expect(next.handle).not.toHaveBeenCalled();
  }
  if (!consumes(RouteParamtypes.QUERY)) {
    expect(() =>
      interceptor.intercept(
        context(controller, handler, undefined, {
          ignored: 'SYNTHETIC-PRIVATE',
        }),
        next,
      ),
    ).toThrow('The request was not valid.');
    expect(next.handle).not.toHaveBeenCalled();
  }
  interceptor.intercept(context(controller, handler, {}, {}), next);
  expect(next.handle).toHaveBeenCalledTimes(1);
});
