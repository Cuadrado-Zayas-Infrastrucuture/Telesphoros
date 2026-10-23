# Security & PHI policy

- Report vulnerabilities privately by email to security@cuadradozayasinfrastructure.com. Do not open a public issue.
- Private vulnerability reporting through GitHub is the intended route. It is not yet enabled, because GitHub does not offer it for this private repository; it is planned for the public release. Until then, use the email address above.
- Never commit PHI, genomic files, or secrets. Secrets live in AWS Secrets Manager.
- Encrypt PHI at rest and in transit; audit every PHI access; never log PHI.
- Training data is synthetic or de-identified only; real clinical data needs its own approved plan and compliance review.
