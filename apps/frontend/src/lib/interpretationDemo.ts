/** Hand-authored UI fixtures, not a clinical rule set or LLM prompt. No report inputs. */
export const DEMO_QUESTIONS = ['Explain this example', 'What evidence is missing?', 'What are the limitations?'] as const;
export const DEMO_SOURCE = 'UI fixture SYN-PGX-UI-01 · revision 1';
const ANSWERS: Record<string, string> = {
  'Explain this example': 'This fictional example demonstrates where an explanation would sit beside a structured PGx result. No genotype, phenotype, medication recommendation or guideline result has been calculated. A future explanation must describe an independently verified result and preserve its evidence and limitations.',
  'What evidence is missing?': 'This example has no accepted laboratory source, verified genotype, versioned guideline result or clinical review. A real interpretation workspace would need those independently verified records before presenting a supported finding. File upload verification alone does not provide that evidence.',
  'What are the limitations?': 'These words are a fixed demonstration response, not model output. They are unrelated to any selected report. The preview cannot interpret a file, recommend treatment, establish clinical approval or save a decision. Reloading or leaving this page clears the conversation.',
};
export function demoAnswer(question: string): string {
  return Object.hasOwn(ANSWERS, question.trim()) ? ANSWERS[question.trim()] : 'This preview only demonstrates three fixed questions. Choose “Explain this example”, “What evidence is missing?” or “What are the limitations?”. Your text was not sent to a model and no report was interpreted.';
}
