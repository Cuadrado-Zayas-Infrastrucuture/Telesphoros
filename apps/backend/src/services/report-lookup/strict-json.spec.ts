import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { canonicalJson } from '../report-adapter/canonical-json';
import { artifactHash, boundedScalars, decodeArtifact, parseRecordJson, recordHash } from './strict-json';
import { ROOT } from '../../../test/helpers/report-lookup';

const ACCEPTED = [
  '{"\\ue000":1,"\\ud83e\\uddec":2}',
  '{"b":[null,true,false,0,-1,9007199254740991],"a":"test"}',
  '{ "a": "test", "b": [null, true, false, 0, -1, 9007199254740991] }',
  '{"text":"\\ufeff\\ud83e\\uddec\\n"}',
  '[]',
  'null',
  '-0',
  '{"__proto__":1}',
];
const REJECTED = [
  '{"a":1,"a":2}',
  '{"a":1,"\\u0061":2}',
  '1.0',
  '1e0',
  '0.5',
  '9007199254740992',
  '"\\ud800"',
  '"\\udfff"',
  '{"\\ud800":1}',
  '{"a":NaN}',
  '{"a":Infinity}',
  '[1,]',
  '{"a":1,}',
  '01',
  'null false',
  '['.repeat(66) + ']'.repeat(66),
];
describe('independent Python / TypeScript restricted record contract', () => {
  test('frozen known-answer record and artifact digests', () => {
    const frozen = JSON.parse(readFileSync(resolve(ROOT, 'sidecars/report-lookup/hash-vectors.json'), 'utf8')) as {
      records: Array<{ raw: string; canonical: string; sha256: string }>;
      artifacts: Array<{ text: string; sha256: string }>;
    };
    for (const vector of frozen.records) {
      expect(canonicalJson(parseRecordJson(vector.raw))).toBe(vector.canonical);
      expect(recordHash(parseRecordJson(vector.raw))).toBe(vector.sha256);
    }
    for (const vector of frozen.artifacts) expect(artifactHash(vector.text)).toBe(vector.sha256);
  });
  test('known-answer bytes, UTF-16 key ordering, all accepted and rejected vectors', () => {
    const vectors = [...ACCEPTED, ...REJECTED];
    const python = JSON.parse(
      execFileSync('python3', ['-I', '-B', resolve(ROOT, 'sidecars/report-lookup/hash_oracle.py')], { input: JSON.stringify(vectors), encoding: 'utf8', timeout: 3000 }),
    ) as Array<{ accepted: boolean; canonical?: string; sha256?: string }>;
    for (const [i, raw] of vectors.entries()) {
      if (i < ACCEPTED.length) {
        expect(python[i]!.accepted).toBe(true);
        const parsed = parseRecordJson(raw);
        expect(canonicalJson(parsed)).toBe(python[i]!.canonical);
        expect(recordHash(parsed)).toBe(python[i]!.sha256);
      } else {
        expect(python[i]!).toEqual({ accepted: false });
        expect(() => parseRecordJson(raw)).toThrow();
      }
    }
    expect(canonicalJson(parseRecordJson(ACCEPTED[0]!))).toBe('{"🧬":2,"":1}');
    expect(recordHash(parseRecordJson(ACCEPTED[1]!))).toBe(recordHash(parseRecordJson(ACCEPTED[2]!)));
  });
  test('BOM, astral scalar slices and exact UTF-8 artifact/newline digests', () => {
    const text = '\ufeff🧬A\n';
    expect(decodeArtifact(Buffer.from(text, 'utf8'))).toBe(text);
    const scalars = boundedScalars(text);
    expect(scalars).toEqual(['\ufeff', '🧬', 'A', '\n']);
    const values = [text, scalars.slice(0, 2).join(''), '{"policy":1}', '{"policy":1}\n'];
    const python = JSON.parse(
      execFileSync('python3', ['-I', '-c', 'import json,hashlib,sys;print(json.dumps([hashlib.sha256(x.encode("utf-8","strict")).hexdigest() for x in json.load(sys.stdin)]))'], {
        input: JSON.stringify(values),
        encoding: 'utf8',
        timeout: 3000,
      }),
    ) as string[];
    expect(values.map(artifactHash)).toEqual(python);
    expect(python[2]).not.toBe(python[3]);
    expect(() => decodeArtifact(new Uint8Array([0xff]))).toThrow();
    expect(() => boundedScalars('\ud800')).toThrow();
  });
  test('size, depth and unsupported domain inputs are refused before admission', () => {
    expect(() => parseRecordJson(' '.repeat(1048577))).toThrow();
    expect(() => boundedScalars('🧬'.repeat(100001))).toThrow();
    expect(() => recordHash({ wrong: undefined })).toThrow();
    expect(() => recordHash({ wrong: 0.5 })).toThrow();
    expect(() => recordHash(new Date())).toThrow();
  });
});
