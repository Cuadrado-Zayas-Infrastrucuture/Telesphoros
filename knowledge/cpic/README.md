# knowledge/cpic

Real CPIC content only, and only content a pharmacist has reviewed and signed. **Empty on purpose** until
real content has been fetched and reviewed. Never put test or invented content here: it lives in
`data/fixtures/knowledge/synthetic/`.

Format, sign-off procedure and the rules the loader enforces: [docs/cpic-integration.md](../../docs/cpic-integration.md).
A test loads this folder under the production rules, so anything unreviewed, edited after review, or
synthetic fails the build. Its signatures are checked wherever the signers' public keys are configured
(`KNOWLEDGE_SIGNER_KEYS`); CI holds no keys, so there the test checks every rule but the signatures.
