# Developer onboarding and infrastructure overview

Date: 2026-10-25

**Implemented.** The repository README links to [Start here](../start-here.md), a local storage-demo walkthrough, and [the documentation map](../README.md). The guide uses the existing launcher, seeded fake users, a disposable PostgreSQL cluster, the pinned Moto input, a repository-authored synthetic PDF and the owned teardown path. The docs index points to current architecture, vocabulary, development rules, records, infrastructure and gated pipeline/AI documents.

**Infrastructure diagram.** The README's Mermaid diagram follows the declared Terraform resources and connections: CloudFront/private web S3, Cognito, WAF/HTTPS load balancer, Fargate API/worker, optional issuer, private RDS, versioned report S3, runtime secrets and CloudWatch/SNS. Supporting encryption, images, AWS audit evidence and the separate state root are linked from the overview. Deployment-profile differences and feature flags remain explicit; the diagram is a design overview rather than a live inventory.

**Scope.** Documentation only. No application code, clinical content, glossary wording, infrastructure configuration, prompts, schema, CI gates or deployment changes. Broader folder READMEs and repository moves remain separate slices.
