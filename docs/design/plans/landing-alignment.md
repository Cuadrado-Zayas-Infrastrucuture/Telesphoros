# Plan: align the product landing with the Telesphoros public site

Status: **draft, plan only.** Nothing here is built, approved for build, deployed or run. It changes no code, no brand policy and no other repository.

## Why

Three web surfaces share one brand but do not look alike. The founder (2026-10-16) said the Cuadrado company site is fine, that the designs do not match across repositories, and chose option (a): the public site's **Product first** design in `jzayas03/telesphoros-site` is the source of truth, and this repository's landing page is brought in line with it. The recent dashboard (PR #129) is **out of scope**: it has its own contract in [branding.md](../branding.md) and [dashboard-brand.md](../../verification/dashboard-brand.md) and is browser-verified.

## What was compared, and how

Read-only, from code, at `Telesphoros-Remastered` main `6f2ddaa`, `telesphoros-site` main `e3c71d8` and `cuadradozayas-site` main `893645f`. No dependency was installed, no page was rendered and no check was run, so everything below is what the source says, not what a browser shows.

## What already matches

- Inter, Poppins, the shield/Rx mark and the company symbol are byte-identical (SHA-256) in all three repositories.
- The core palette `#225560`, `#368798` and `#46616a` is pinned in all three. Paper `#f5f6f7`, seafoam `#dcebe7` and sand `#e8e7e2` are shared by this repository and the public site.
- Both Telesphoros landings state the same boundary: synthetic data only, patient-linked report intake, file details and storage status, no clinical interpretation or prescribing recommendation.
- Both have a hero, a workflow preview, a capabilities section, a questions section and a closing section.

## What differs

| # | Area | This repository (`ProductLanding.tsx`) | Public site (`ProductFirstLanding.jsx`) |
|---|---|---|---|
| 1 | **Hero artwork** | `particle-dna-reference.png` (SHA-256 `2e4c1dcf…`) behind the headline | Original static `genomic-bands.svg` and an A/C/G/T texture; the retired image is on the site's `retiredHashes` list |
| 2 | **Hero composition** | Eyebrow, headline "A clearer view of …", particles, DNA image | Dark stage with the working synthetic report preview as the dominant visual; headline "Reports, in clearer view." |
| 3 | **Languages** | English only, hard-coded in the component | Full EN/ES parity with a language control |
| 4 | **Sections** | Why we are building, workspace, capabilities, questions, mascot welcome closing | Workflow, "Genomics, with context", capabilities, questions, closing with the company link |
| 5 | **Token names** | `--background`, `--foreground`, `--primary` and a larger scale | `--brand-ink`, `--brand-paper`, `--brand-seafoam`, `--font-content`, `--font-wordmark` |
| 6 | **Brand checks** | `check:brand` pins the DNA image as a **required** asset | `check:site` and `check:built` fail the build if retired material ships |

## Finding that comes first: a conflict about one image

`particle-dna-reference.png` has the same hash in all three repositories, but they disagree about it:

- This repository pins it as an approved, required asset in `apps/frontend/scripts/branding-policy.json`, and `apps/frontend/src/assets/particle-dna-provenance.md` says the watermark "remains intact" and that "publication rights or a watermark-free licensed master have not been established".
- `cuadradozayas-site` lists it under `retiredAssets` and its design contract says the watermarked DNA image "must not ship". `telesphoros-site` lists the same hash first under `retiredHashes`.

So the product landing is the one surface still carrying an image the other two retired. This should be settled before any look-and-feel work, and changing it needs the founder's explicit approval and a reviewed policy update (branding.md: "Brand changes require explicit approval and a reviewed policy update with visual evidence").

## Proposed slices (each its own plan and draft PR; none starts without a go)

1. **S1: retire the watermarked image from the landing. Approved 2026-10-16 and built: the image, its provenance note, the hero element, its CSS and tokens were removed, the policy pin was replaced by a `retiredAssets` list, and the checker now hashes every shipped file. No replacement art was added; S2 decides the hero.** Original wording: Remove it from the hero and from the required-asset list in the policy, and add it to a retired list the way the site repositories do. Replace it with the site's original `genomic-bands.svg` (SHA-256 `b7f48ad8…`, already pinned in both site repositories) or another original asset. Needs the founder's approval first.
2. **S2: hero composition. Approved 2026-10-16 (plan defaults) and built: a still synthetic report card beside the copy, over a token-coloured code-drawn backdrop ported from the site; particles kept; copy unchanged. Not interactive: the interactive walkthrough stays below the hero.** Original wording: Bring the hero to the dark stage with the report preview as the main visual, using the site's copy and structure as the reference.
3. **S3: EN/ES parity.** Give the landing the same two languages, sourcing copy from one place rather than duplicating it. The existing i18n setup in this repository has not been read; that is the first thing to check.
4. **S4: token names.** Add the site's names as aliases of the existing tokens, or the reverse, so one colour change reaches both. Optional and lowest priority.

**Out of scope:** the dashboard, the Reports and Upload pages, the SMART pilot UI, `telesphoros-site` and `cuadradozayas-site` themselves (this repository cannot change them), Vercel and DNS.

## Decisions only the founder can make

- **Approve S1** (retire the watermarked image and change the policy). Recommended first.
- **Copy source of truth:** keep copy in the site repository's `copy.js` and mirror it here, or move shared copy somewhere both can read. Without one, the two will drift again.
- **Header and navigation:** whether the product landing carries the site's header (Workflow, Genomics, Questions, Company) or keeps the application shell. The application shell was not examined for this plan.
- **Who owns `www.telesphoros.app` at launch** (see [domains-and-hosting.md](../../ops/domains-and-hosting.md)): it decides whether two Telesphoros landings should exist at all.

## Risks and open points

- Source comparison is not visual review: spacing, motion, contrast and mobile behaviour still need browser evidence at 320, 375, 390, 768 and 1440 px.
- The site's "Product first" page is itself new (merged 2026-10-16); aligning to it freezes a design that has had little time in front of users.
- Removing a required asset changes `check:brand`; its mutation tests must be updated in the same slice so the guard stays honest.
- This repository's `main` keeps the watermarked image until S1 is approved and merged.

## What it does not touch

Application and backend code, the brand policy and assets, the dashboard, CI, Terraform, the two site repositories, Vercel and DNS. This plan applies nothing.
