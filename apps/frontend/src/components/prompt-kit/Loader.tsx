// Adapted from Prompt Kit circular loader; see README.md and LICENSE.md.
/** A ring that turns while something is being prepared. Progress, so it takes the signal colour (specs/043 D4). */
export function Loader() {
  return <span aria-hidden="true" className="size-4 shrink-0 rounded-full border-2 border-signal border-t-transparent motion-safe:animate-spin" />;
}
