import type { Observation } from "./domain.js";
import type { RunContext } from "./run.js";
import type { ReportStep } from "./report.js";

export type WorkflowStepStatus = ReportStep["status"];

export interface WorkflowStepContext {
  readonly run: RunContext;
  readonly before?: Observation;
  readonly after?: Observation;
}

export interface WorkflowStepDefinition {
  readonly id: string;
  readonly description: string;
  readonly execute: (context: WorkflowStepContext) => Promise<readonly string[]>;
  readonly recover?: (context: WorkflowStepContext, error: unknown) => Promise<void>;
}

export interface WorkflowResult {
  readonly status: "passed" | "failed" | "blocked";
  readonly steps: readonly ReportStep[];
}

export async function executeWorkflow(run: RunContext, definitions: readonly WorkflowStepDefinition[]): Promise<WorkflowResult> {
  const steps: ReportStep[] = [];
  for (const definition of definitions) {
    const started = Date.now();
    let status: WorkflowStepStatus = "failed";
    let evidence: readonly string[] = [];
    let message: string | undefined;
    try {
      const before = await run.driver.observe(run.device.id);
      evidence = await definition.execute({ run, before });
      status = "passed";
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      try {
        if (definition.recover) await definition.recover({ run }, error);
      } catch (recoveryError) {
        message += `; recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`;
      }
    }
    const record: ReportStep = {
      index: steps.length + 1,
      description: definition.description,
      status,
      evidence,
      ...(message ? { message } : {}),
      durationMs: Date.now() - started,
    };
    steps.push(record);
    await run.evidence.appendStep(record);
    if (status === "failed") return { status: "failed", steps };
  }
  return { status: "passed", steps };
}
