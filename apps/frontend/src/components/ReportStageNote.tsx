/** Fixed copy, shown while counting too: it explains a stage, and it keeps the section's height steady. */
export function ReportStageNote({ cap }: { cap?: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Read means the system processed the record; it is not clinical review.
      {cap}
    </p>
  );
}
