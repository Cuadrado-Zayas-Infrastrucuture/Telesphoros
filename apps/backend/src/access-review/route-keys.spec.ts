import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { EvaluationsController } from '../lab-reports/evaluations.controller';
import { PatientDemographicsController } from '../patient-demographics/patient-demographics.controller';
import { PatientIdentifiersController, ReportPatientLinkController } from '../patient-identity/patient-identity.controller';
import { PatientMedicationsController } from '../patient-medications/patient-medications.controller';
import { PatientsController } from '../patients/patients.controller';
import { ReportsController } from '../reports/reports.controller';
import { SUBJECT_KIND_BY_ROUTE, subjectKindOf } from './route-keys';

// Spec 046 T-7: the route keys the review resolves are read from the controllers' own routing metadata, so a patient-scoped read added later fails
// here until it is classified. The follow-ups controller is module-local (not exported), so its one read is named by hand below.
const CONTROLLERS = [
  PatientsController,
  PatientIdentifiersController,
  ReportPatientLinkController,
  PatientMedicationsController,
  PatientDemographicsController,
  EvaluationsController,
  ReportsController,
];
const MODULE_LOCAL = { 'PatientFollowupsController.read': 'patient' } as const;

function getRoutes() {
  const routes: Array<{ key: string; path: string }> = [];
  for (const cls of CONTROLLERS) {
    const base = String(Reflect.getMetadata(PATH_METADATA, cls) ?? '').replace(/^\/|\/$/g, '');
    for (const name of Object.getOwnPropertyNames(cls.prototype)) {
      if (name === 'constructor') continue;
      const fn = (cls.prototype as unknown as Record<string, unknown>)[name];
      if (typeof fn !== 'function' || Reflect.getMetadata(METHOD_METADATA, fn) !== RequestMethod.GET) continue;
      const own = String(Reflect.getMetadata(PATH_METADATA, fn) ?? '').replace(/^\/|\/$/g, '');
      routes.push({ key: `${cls.name}.${name}`, path: [base, own].filter(Boolean).join('/') });
    }
  }
  return routes;
}

describe('the route keys the access review resolves (spec 046 T-7)', () => {
  const routes = getRoutes();

  it('finds the reads it should (a scan that finds nothing proves nothing)', () => {
    expect(routes.map((r) => r.key)).toEqual(expect.arrayContaining(['PatientsController.get', 'EvaluationsController.list', 'ReportsController.downloadUrl']));
  });

  it('classifies every GET under patients/:id as patient, evaluations/:id as evaluation and reports/:id as report, and nothing else but the evaluations list', () => {
    for (const { key, path } of routes) {
      const expected = /^patients\/:id(\/|$)/.test(path)
        ? 'patient'
        : /^evaluations\/:id(\/|$)/.test(path)
          ? 'evaluation'
          : /^reports\/:id(\/|$)/.test(path)
            ? 'report'
            : key === 'EvaluationsController.list'
              ? 'patient'
              : undefined;
      expect({ key, path, kind: SUBJECT_KIND_BY_ROUTE[key] }).toEqual({ key, path, kind: expected });
    }
  });

  it('names no route that does not exist, besides the module-local follow-ups read', () => {
    const known = new Set(routes.map((r) => r.key));
    expect(Object.keys(SUBJECT_KIND_BY_ROUTE).filter((k) => !known.has(k))).toEqual(Object.keys(MODULE_LOCAL));
    for (const [key, kind] of Object.entries(MODULE_LOCAL)) expect(SUBJECT_KIND_BY_ROUTE[key]).toBe(kind);
  });

  it('calls anything unlisted "other"', () => {
    expect(subjectKindOf('UsageController.get')).toBe('other');
    expect(subjectKindOf('PatientsController.get')).toBe('patient');
  });
});
