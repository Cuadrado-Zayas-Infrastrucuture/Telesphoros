/**
 * How a clinician is shown. The API stores no name or e-mail for a member, only an opaque subject id
 * ("Never an e-mail address or a name", shared-types members.ts), so there is no name to show. A raw id
 * is unreadable and looks like a fault; this turns it into a short, stable label instead:
 * the signed-in clinician's own word ("Me", "You"), or "Clinician" plus the id's last four characters.
 * The label is for reading only: forms keep sending the id itself.
 */
export function clinicianLabel(id: string | null | undefined, actor?: string | null, self = 'Me'): string {
  if (!id) return 'Unknown clinician';
  if (actor && id === actor) return self;
  const tail = id
    .replace(/[^a-z0-9]/gi, '')
    .slice(-4)
    .toUpperCase();
  return tail ? `Clinician ${tail}` : 'Clinician';
}
