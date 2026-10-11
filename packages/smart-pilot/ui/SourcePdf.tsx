import { useEffect, useState } from "react";
import type { PgxFhirBundle } from "../src/pgx-fhir.js";

/** Local bytes only: never navigate to an upstream signed URL. Revoke on expiry, unmount or chart change. */
export function SourcePdf({ bundle }: { bundle: PgxFhirBundle | null }) {
  const [url, setUrl] = useState<string | null>(null);
  const document = bundle?.entry.find(e => e.resource.resourceType === "DocumentReference")?.resource;
  const content = (document as { content?: { attachment?: { contentType?: string; data?: string } }[] } | undefined)?.content;
  const attachment = content?.[0]?.attachment;
  const data = attachment?.contentType === "application/pdf" ? attachment.data : undefined;
  useEffect(() => {
    setUrl(null);
    if (!data || data.length > 14 * 1024 * 1024) return;
    let local: string;
    try {
      const decoded = atob(data);
      if (!decoded.startsWith("%PDF-")) return;
      local = URL.createObjectURL(new Blob([Uint8Array.from(decoded, c => c.charCodeAt(0))], { type: "application/pdf" }));
      setUrl(local);
    } catch { return; }
    return () => URL.revokeObjectURL(local);
  }, [data]);
  return url ? <p><a href={url} download="synthetic-source.pdf">Download verified synthetic source PDF</a></p>
    : <p>Source PDF bytes are unavailable in this preview.</p>;
}
