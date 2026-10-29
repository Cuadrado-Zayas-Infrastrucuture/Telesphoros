# Feature Specification: Skeleton loading (SKL)

**Feature Branch**: `feat/skeleton-loading`

**Created**: 2026-10-28

**Status**: Approved 2026-10-28 ("Yes, build it"), with a shimmer and a 150 ms delay. The founder asked for more of the shadcn/ui Skeleton patterns (https://ui.shadcn.com/docs/components/base/skeleton) for a more premium front end.

## Decisions

- **D1, motion:** a slow, faint sweep (`.skeleton` in `styles/index.css`) replaces the pulse. Placeholders stay invisible for `--delay-skeleton` (150 ms), so fast loads never flash. Reduced motion keeps the shape and drops the sweep; forced colours draw an outline. CSS only: no timers.
- **D2, pieces:** `SkeletonText`, `SkeletonCard` and `SkeletonTableRows`, composed after the shadcn Text, Card and Table examples. Each copies the shape of the content it stands in for.
- **D3, where:** Usage (two month cards and storage, instead of one block); the report list (now built on `SkeletonTableRows`, looking the same); the organization row and Report stages keep their placeholders and gain the sweep.
- **D4, announcements:** a placeholder is hidden from assistive technology, so each loading area has one `role="status"` line ("Loading usage…", "Loading the organization…"). It replaces two `aria-label`s that sat on hidden elements and were never read.
- **D5, not used:** a page skeleton while switching pages (the router keeps the current page on screen until the next one loads, so a skeleton would sit over a live page); the Upload form (it is already real and usable while patients load); the Avatar and Form examples (nothing in the app has their shape).

## Requirements

- **SKL-1** The highlight is a token in both themes (`--skeleton-highlight`), pinned by `check:brand`.
- **SKL-2** No WCAG A/AA violations while loading, in either theme.
