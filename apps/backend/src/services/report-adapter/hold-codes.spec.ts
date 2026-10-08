import { holdCodeForReaderReason, READER_HOLD_CODES, REPORT_HOLD_ACTIONS, REPORT_HOLD_CODES, REPORT_HOLD_MESSAGES } from './hold-codes';

describe('the report-level hold vocabulary (frozen by docs/design/report-adapter-spec.md, section 6)', () => {
  it('is exactly the sixteen codes of the specification', () => {
    expect([...REPORT_HOLD_CODES]).toEqual([
      'capture-not-accepted', 'capture-hash-mismatch', 'poppler-version-mismatch', 'reader-binding-mismatch', 'packet-invalid', 'evidence-overlap',
      'unsupported-layout', 'alignment-unsupported', 'unsupported-column-layout', 'unaccounted-text', 'mixed-frame-set', 'selector-quarantined',
      'source-limit', 'candidate-or-frame-limit', 'source-time-budget', 'worker-error',
    ]);
  });

  it('has a fixed message and a reviewer action for every code, and neither can carry report text', () => {
    for (const code of REPORT_HOLD_CODES) {
      for (const text of [REPORT_HOLD_MESSAGES[code], REPORT_HOLD_ACTIONS[code]]) {
        expect(text.length).toBeGreaterThan(10);
        expect(text).not.toMatch(/[{}<>$`"]|%s|undefined/);
      }
    }
    expect(Object.keys(REPORT_HOLD_MESSAGES).sort()).toEqual([...REPORT_HOLD_CODES].sort());
    expect(Object.keys(REPORT_HOLD_ACTIONS).sort()).toEqual([...REPORT_HOLD_CODES].sort());
  });

  it('keeps the reader\'s own reason strings unchanged, and nothing else, as the reader codes', () => {
    expect([...READER_HOLD_CODES]).toEqual(REPORT_HOLD_CODES.slice(6));
    for (const code of READER_HOLD_CODES) expect(holdCodeForReaderReason(code)).toBe(code);
  });

  it('does not recognize a reason it does not know, so the caller can treat it as a defect', () => {
    for (const reason of [null, '', 'registered-source-ambiguity', 'some-new-reason', 'capture-not-accepted'.toUpperCase()]) expect(holdCodeForReaderReason(reason)).toBeNull();
    // Adapter-raised codes are not reader reasons: a reader cannot name them.
    expect(holdCodeForReaderReason('capture-not-accepted')).toBeNull();
  });
});
