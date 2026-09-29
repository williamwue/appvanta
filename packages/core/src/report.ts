import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunMetadata } from "./domain.js";

export interface ReportStep {
  readonly index: number;
  readonly description: string;
  readonly status: "passed" | "failed" | "blocked" | "skipped" | "cancelled";
  readonly durationMs?: number;
  readonly evidence?: readonly string[];
  readonly message?: string;
  readonly output?: string;
  readonly conditionMatched?: boolean;
}

export interface RunReportInput {
  readonly metadata: RunMetadata;
  readonly deviceName: string;
  readonly steps: readonly ReportStep[];
}

export function renderMarkdownReport(input: RunReportInput): string {
  const passed = input.steps.filter((step) => step.status === "passed").length;
  const failed = input.steps.filter((step) => step.status === "failed" || step.status === "blocked").length;
  const rows = input.steps.map((step) => {
    const evidence = step.evidence?.join(", ") ?? "";
    return `| ${step.index} | ${step.description.replaceAll("|", "\\|")} | ${step.status} | ${step.durationMs ?? ""} | ${evidence} |`;
  }).join("\n");
  return `# AppVanta Run Report\n\n- Run: \`${input.metadata.runId}\`\n- Device: ${input.deviceName}\n- Driver: ${input.metadata.driver}\n- Started: ${input.metadata.startedAt}\n- Result: **${input.metadata.status}**\n- Steps passed: ${passed}\n- Steps failed or blocked: ${failed}\n\n## Steps\n\n| # | Description | Status | Duration (ms) | Evidence |\n|---:|---|---|---:|---|\n${rows || "| - | No steps recorded | - | - | - |"}\n`;
}

export async function writeMarkdownReport(rootDirectory: string, input: RunReportInput): Promise<string> {
  const path = join(rootDirectory, "report.md");
  const errors = input.steps.filter((step) => step.message).map((step) => `- Step ${step.index}: ${step.message}`).join("\n");
  const output = input.steps.filter((step) => step.output).map((step) => `### Step ${step.index}: ${step.description}\n\n${step.output}\n`).join("\n");
  await writeFile(path, renderMarkdownReport(input) + (output ? `\n## Step output\n\n${output}` : "") + (errors ? `\n## Step diagnostics\n\n${errors}\n` : ""), "utf8");
  return path;
}
