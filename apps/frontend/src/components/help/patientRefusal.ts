import { BUNDLED_DRUG_LIST } from '@telesphoros/shared-types/drug-list-data';

/** Lowercases, strips diacritics, and normalizes whitespace for deterministic matching. */
export function normalizeHelpText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Signal 1: synthetic patient label pattern (e.g. SYN-0042).
const PATIENT_LABEL_PATTERN = /\bsyn-\d+[a-z0-9-]*\b/;

// Signal 2: star allele, diplotype or numeric activity score (e.g. *2/*2, CYP2C19*17, activity score 1.5).
const STAR_ALLELE_OR_DIPLOTYPE_PATTERN = /(?:^|[\s(,/])\*[0-9]+[a-z0-9]*|\b(?:cyp[0-9][a-z][0-9]+|slco1b1|tpmt|nudt15|dpyd|ugt1a1|vkorc1|hla-[a-z0-9]+)\s*\*[0-9]+/;
const ACTIVITY_SCORE_VALUE_PATTERN = /\bactivity\s+score\s+(?:of\s+|is\s+|:\s*)?\d+(?:\.\d+)?\b/;

// Signal 3 & 4: patient-referring expressions in English and Spanish.
const PATIENT_PHRASE_PATTERN =
  /\b(?:my patient|this patient|that patient|our patient|a patient'?s|the patient'?s|patient'?s|mi paciente|este paciente|esta paciente|ese paciente|esa paciente|el paciente|la paciente|del paciente|paciente|should (?:he|she|they)|can (?:he|she|they)|does (?:he|she|they)|for (?:him|her))\b/;

const ANY_PATIENT_WORD_PATTERN = /\b(?:patients?|pacientes?)\b/;

// Clinical / dosing / medication words in English and Spanish (Signal 3).
const CLINICAL_WORD_PATTERN =
  /\b(?:dose|dosing|dosage|mg|milligram|milligrams|prescribe|prescribing|prescription|give|giving|take|taking|start|starting|stop|stopping|switch|switching|change|changing|adjust|adjusting|medication|medications|medicine|drug|drugs|therapy|treatment|safe|contraindicated|interact|interaction|metabolizer|phenotype|diplotype|genotype|dosis|medicamento|medicamentos|medicina|recetar|dar|darle|tomar|iniciar|suspender|cambiar|ajustar|tratamiento|seguro|interaccion)\b/;

const BUNDLED_DRUG_NAMES: readonly string[] = (() => {
  const names = new Set<string>();
  const add = (raw: string) => {
    const normalized = normalizeHelpText(raw);
    if (normalized.length >= 3) names.add(normalized);
  };
  for (const entry of BUNDLED_DRUG_LIST?.entries ?? []) {
    add(entry.name);
    add(entry.displayName);
    if (entry.tty === 'MIN' || entry.name.includes(' / ')) {
      for (const part of entry.name.split(' / ')) add(part);
    }
    for (const brand of entry.brands ?? []) {
      add(brand.name);
    }
  }
  return [...names];
})();

function containsBundledDrug(normalizedQuery: string): boolean {
  if (BUNDLED_DRUG_NAMES.length === 0) return false;
  const words = new Set(normalizedQuery.split(/[^a-z0-9]+/).filter((word) => word.length >= 3));
  for (const drug of BUNDLED_DRUG_NAMES) {
    if (!drug.includes(' ')) {
      if (words.has(drug)) return true;
    } else if (normalizedQuery.includes(drug)) {
      return true;
    }
  }
  return false;
}

/**
 * Spec 051 section 5 (H-D6): deterministic rule checked BEFORE searching. Returns true when a typed question
 * appears to be about a specific patient rather than how the product works.
 */
export function isPatientQuestion(rawQuery: string): boolean {
  const normalized = normalizeHelpText(rawQuery);
  if (!normalized) return false;

  if (PATIENT_LABEL_PATTERN.test(normalized)) return true;
  if (STAR_ALLELE_OR_DIPLOTYPE_PATTERN.test(normalized)) return true;
  if (ACTIVITY_SCORE_VALUE_PATTERN.test(normalized)) return true;

  const hasPatientPhrase = PATIENT_PHRASE_PATTERN.test(normalized);
  if (hasPatientPhrase && CLINICAL_WORD_PATTERN.test(normalized)) return true;

  if ((hasPatientPhrase || ANY_PATIENT_WORD_PATTERN.test(normalized)) && containsBundledDrug(normalized)) {
    return true;
  }

  return false;
}
