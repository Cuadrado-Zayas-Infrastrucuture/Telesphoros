# Security policy

Telesphoros is clinical decision support for pharmacogenomics. It is under construction, uses **synthetic data only**, and is **not approved for clinical use**. No instance of it is deployed with real patient data. A security report is still welcome: the code is built to be safe with patient data before any real data reaches it.

## Reporting a vulnerability

Report privately. **Do not open a public issue, pull request or discussion for a security problem.**

1. **Preferred:** GitHub private vulnerability reporting. On this repository open **Security**, then **Report a vulnerability**.
2. **Fallback:** email security@cuadradozayasinfrastructure.com. It reaches the maintainer. It is not a support line (see [SUPPORT.md](SUPPORT.md)).

Include what you found, where, how to reproduce it, and what an attacker could do with it. **Never include patient data, real lab reports, real genetic results or credentials** in a report, even as an example; a description or synthetic data is enough.

## What to expect

This project is maintained by one person on a best-effort basis, with no service-level commitment. The aim is to acknowledge a report within seven days and to say whether it is accepted. Fixes are made in private and released with an advisory. Please keep the details private until a fix is released, or for 90 days after your report, whichever is sooner, and say so if you need a different timeline. You are credited in the advisory unless you ask not to be.

## Scope

- **In scope:** the code in this repository, run from a checkout on your own machine: the API, the web app, the worker, the database migrations, the Terraform in `infrastructure/`, and the CI configuration.
- **Out of scope:** any hosted system (none is deployed today), real patient or customer data, denial-of-service by volume, social engineering, and problems in third-party packages that are not specific to how this project uses them (report those upstream; tell us if our use makes them exploitable).
- **Do not** test against any system you do not own, and do not use real patient data to test anything.

## Supported versions

Only the latest commit on `main`. The project is pre-1.0 and has no released versions yet.

## What the project commits to

- Never commit PHI, genomic files, or secrets. Secrets live in AWS Secrets Manager.
- Encrypt PHI at rest and in transit; audit every PHI access; never log PHI.
- Training data is synthetic or de-identified only; real clinical data needs its own approved plan and compliance review.
