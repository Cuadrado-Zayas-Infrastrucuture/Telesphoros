import { ReviewedControlBody } from './ReviewedControlBody';

/**
 * Spec 019 D02a: the clinician's "Reviewed" control for one result row. It shows `Review` (or `Retraction reviewed` when the result is retracted, never a
 * generic review of it), and shows a review as recorded ONLY after the server's 201 or 200 (P4). A refusal (409) asks for a refresh; a lost answer is
 * retried with the same request, so it cannot store a second review. A different result (or patient: the page keys the control by both) is a new mount,
 * so nothing pending for the previous one can finish here.
 */
export function ReviewedControl({ resultId }: { resultId: string }) {
  return <ReviewedControlBody key={resultId} resultId={resultId} />;
}
