/** Render capture (spec 019 D02b): the refusals the repository can raise. Nothing in the batch was written when one is raised. */

/** A result the batch names is not in the caller's organization (or does not exist). FR-02: 404, as everywhere else. */
export class ResultRenderNotFoundError extends Error {}
/** A duration event has no stored exposure for its episode, result and path (R1). */
export class ResultRenderExposureMissingError extends Error {}
/** The live membership row does not hold a clinical read role (FR-06). */
export class ResultRenderNotReaderError extends Error {}
