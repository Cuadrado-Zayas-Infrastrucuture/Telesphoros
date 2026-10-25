/** Questionnaire navigation pattern, adapted to the dashboard's native controls and tokens.
 * Reference: https://ui.shadcn.com/docs/components/base/questionnaire
 * Navigation is separate from completion: visiting a step never means a file was verified.
 */
export function QuestionnaireProgress({ steps, active }: { steps: readonly string[]; active: number }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground" aria-live="polite">
        Step {active + 1} of {steps.length}: {steps[active]}
      </p>
      <progress aria-label="Upload guide progress" max={steps.length} value={active + 1} className="questionnaire-progress h-2 w-full overflow-hidden rounded-sm" />
      <ol aria-label="Upload guide steps" className="grid grid-cols-3 gap-3 text-sm">
        {steps.map((step, index) => (
          <li
            key={step}
            aria-current={index === active ? 'step' : undefined}
            className={index === active ? 'border-b-2 border-primary pb-2 font-semibold' : 'border-b border-divider pb-2 text-muted-foreground'}
          >
            {index + 1}. {step}
          </li>
        ))}
      </ol>
    </div>
  );
}
