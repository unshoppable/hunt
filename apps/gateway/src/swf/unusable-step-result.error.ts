/**
 * A step result the pipeline cannot act on (`Pipeline.acceptResult` in `swf/pipeline.domain.ts`): no step marker, a marker
 * the parser refused or the result of another step than the current one. The poller (`swf/poller.service.ts`) tells the
 * agent its message, the problem.
 */
export class UnusableStepResult extends Error {
  constructor(problem: string) {
    super(problem);
    this.name = "UnusableStepResult";
  }
}
