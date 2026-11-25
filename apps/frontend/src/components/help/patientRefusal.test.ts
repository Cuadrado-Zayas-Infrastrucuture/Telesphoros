import { describe, expect, it } from 'vitest';
import { isPatientQuestion } from './patientRefusal';

describe('isPatientQuestion (spec 051 section 5, H-D6)', () => {
  const MUST_REFUSE = [
    // Signal 1: patient label pattern
    'what should I give SYN-0042?',
    'SYN-0001 clopidogrel',
    'check syn-123 status',
    // Signal 2: star allele, diplotype or activity score
    '*2/*2',
    'CYP2C19*17',
    'what does CYP2D6 *4/*4 mean for dosing',
    'activity score 1.5',
    'activity score is 0.5',
    // Signal 3: patient word with a clinical word (English and Spanish)
    'what dose should I give my patient',
    'my patient dose',
    'should she take a lower dose',
    'can he stop this medication',
    'este paciente puede tomar este medicamento',
    'qué dosis para mi paciente',
    'el paciente necesita cambiar de tratamiento',
    // Signal 4: bundled drug name (ingredient or brand) together with a patient word
    'can my patient take clopidogrel',
    "this patient's clopidogrel",
    "this patient's Plavix",
    'warfarin for my patient',
    'patient omeprazole',
  ];

  const MUST_ANSWER = [
    'what is a held result',
    'how do I add a patient',
    'how do I find a patient',
    'patient follow-up date',
    'what does phenotype mean',
    'what is phenoconversion',
    'how do I attach a report',
    'what roles exist',
    'where are the policies',
    'what does activity score mean',
    'why is recording a decision switched off',
    'what does the home page show',
    'synthetic data only',
  ];

  it.each(MUST_REFUSE)('refuses patient question: %s', (question) => {
    expect(isPatientQuestion(question)).toBe(true);
  });

  it.each(MUST_ANSWER)('does not refuse general product question: %s', (question) => {
    expect(isPatientQuestion(question)).toBe(false);
  });

  it('returns false for empty or whitespace-only input', () => {
    expect(isPatientQuestion('')).toBe(false);
    expect(isPatientQuestion('   ')).toBe(false);
  });
});
