# Shared button progress
Date: 2026-10-31

`Button` accepts `pending` and `pendingLabel` for actions. Supply the label in both states to reserve the space needed for the idle and progress labels, including the spinner. Pending disables activation and exposes `aria-busy`; a separate polite status announces progress. Reduced motion stops the spinner. The `asChild` link variant excludes the pending props.

Sign-in, the deployed and local upload forms, and both patient-creation buttons now use this shared behavior. Existing request, cancellation, validation and permission handling stays with each caller. No backend or deployment changes.

```tsx
<Button type="submit" pending={saving} pendingLabel="Saving…" disabled={!valid}>
  Save
</Button>
```

The caller owns `saving`, errors and retries. Keep `pendingLabel` present while idle so the layout can reserve its space. `disabled` remains independent: ending a request does not enable an invalid form. `pending` has priority over `disabled={false}`. Native disabling blocks pointer and keyboard activation; it is not a substitute for request idempotency.
