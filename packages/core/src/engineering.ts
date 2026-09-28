import { compareRunMetadata } from './run-comparison.js';
import { stageEvidence } from "./archive.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

export interface RunComparison { readonly scope: "run" | "steps-only"; readonly baseline: string; readonly current: string; readonly status: "passed" | "failed"; readonly differences: readonly string[]; }

export async function compareRuns(baselineDirectory: string, currentDirectory: string, options: { stepsOnly?: boolean } = {}): Promise<RunComparison> {
  const differences: string[] = options.stepsOnly ? [] : await compareRunMetadata(baselineDirectory, currentDirectory);
  const read = async (root: string, file: string) => { try { return await readFile(join(root, file), "utf8"); } catch { return undefined; } };
  const [a, b] = await Promise.all([read(baselineDirectory, "steps.jsonl"), read(currentDirectory, "steps.jsonl")]);
  if (!a || !b) differences.push("steps.jsonl missing");
  else {
    const parse = (text: string) => text.split(/\r?\n/).filter(Boolean).map((line): { index: number; description: string; status: string } => {
      const item: unknown = JSON.parse(line);
      if (!item || typeof item !== "object" || !("index" in item) || typeof item.index !== "number" || !Number.isInteger(item.index)
        || !("description" in item) || typeof item.description !== "string" || !("status" in item) || typeof item.status !== "string"
        || !["passed", "failed", "blocked", "skipped"].includes(item.status)) throw new Error("Invalid step record");
      return { index: item.index, description: item.description, status: item.status };
    });
    try {
      const before = parse(a), after = parse(b);
      if (!before.length || !after.length) differences.push("Empty step records");
      if (before.length !== after.length) differences.push(`Step count changed: ${before.length} -> ${after.length}`);
      for (const [i, step] of after.entries()) {
        if (step.index !== i + 1) differences.push(`Invalid step sequence at ${i + 1}`);
        if (step.status !== "passed") differences.push(`Step ${step.index} is ${step.status}`);
        const previous = before[i];
        if (previous && (previous.description !== step.description || previous.index !== step.index)) differences.push(`Step identity changed at ${i + 1}`);
        if (previous && previous.status !== step.status) differences.push(`Step ${step.index}: ${previous.status} -> ${step.status}`);
      }
      for (const [i, step] of before.entries()) {
        if (step.index !== i + 1 || step.status !== "passed") differences.push(`Baseline step ${i + 1} is not a valid passing baseline`);
      }
    } catch (error) { differences.push(`Cannot compare records: ${String(error)}`); }
  }
  return { scope: options.stepsOnly ? "steps-only" : "run", baseline: baselineDirectory, current: currentDirectory, status: differences.length ? "failed" : "passed", differences };
}

export async function exportEvidence(runDirectory: string, destination: string): Promise<string> {
  await mkdir(destination, { recursive: true });
  await stageEvidence(runDirectory, join(destination, basename(runDirectory)));
  return join(destination, basename(runDirectory));
}

export async function writeBaseline(path: string, values: Record<string, number>): Promise<void> {
  await writeFile(path, `${JSON.stringify({ version: 1, values }, null, 2)}\n`, "utf8");
}

export function checkBaseline(baseline: unknown, current: unknown): { readonly passed: boolean; readonly violations: readonly string[] } {
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  if (!record(baseline) || !Object.keys(baseline).length || !record(current)) return { passed: false, violations: ["Non-empty baseline and metrics objects are required"] };
  const violations: string[] = [];
  for (const [key, limit] of Object.entries(baseline)) {
    if (typeof limit !== "number" || !Number.isFinite(limit) || limit < 0) { violations.push(`${key}: invalid threshold`); continue; }
    if (!Object.hasOwn(current, key) || typeof current[key] !== "number" || !Number.isFinite(current[key]) || current[key] < 0) {
      violations.push(`${key}: missing or invalid measurement`);
    } else if (current[key] > limit) violations.push(`${key}: ${current[key]} > ${limit}`);
  }
  return { passed: violations.length === 0, violations };
}
