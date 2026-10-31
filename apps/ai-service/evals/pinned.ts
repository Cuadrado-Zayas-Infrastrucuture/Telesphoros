/**
 * The digests the gate was last measured against. Changing the template, the glossary, a lexicon, the gated model's identity
 * or a limit (EXPLAIN_LIMITS, OUTPUT_CAPS) changes the harness
 * version; the gate is red until these are updated in a reviewed diff, which is the moment to re-measure (FR-010, FR-013).
 */
export const PINNED: Readonly<Record<string, string>> = {
  template: 'sha256:4d6ad7a79f917730a4a4370c90fb01b0be06a74a78afdda0d48e779c6bec6ce7',
  repair: 'sha256:891dd4a37f594a307813d18a85d02b026fa1674637983146509b9e17d257f96c',
  verify: 'sha256:a87352a18cb0a2c01403807d66e0e3c10162a50358e41eeef5596ca3a3441577',
  lexicon: 'sha256:eededdb94230c265e87bf55d08a8fdb082b237b4429f40c027053fcbe5d08254',
  glossary: 'sha256:9ebd27cb21dd93c97216603a166e90c15d1aa4b4927998e1e258527c247b456d',
  model: 'sha256:4fd7c803068e47f164356d25f2ee08b406682cf838fefd6e8d719e0af31f9be6',
  limits: 'sha256:da329b555d49224f765056bea48432065f04bb9f3d07340c252f65086fc0aaf3',
};
