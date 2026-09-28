import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Action, Observation, RunId, RunMetadata } from "./domain.js";

export interface EvidenceStore {
  initialize(metadata: RunMetadata): Promise<void>;
  appendStep(step: object): Promise<void>;
  saveObservation(label: string, observation: Observation): Promise<void>;
  savePlan(content: string): Promise<void>;
}

export class FileEvidenceStore implements EvidenceStore {
  public constructor(private readonly rootDirectory: string) {}

  public async initialize(metadata: RunMetadata): Promise<void> {
    await Promise.all([
      mkdir(join(this.rootDirectory, "screenshots"), { recursive: true }),
      mkdir(join(this.rootDirectory, "ui"), { recursive: true }),
      mkdir(join(this.rootDirectory, "logs"), { recursive: true }),
      mkdir(join(this.rootDirectory, "traces"), { recursive: true }),
    ]);
    await writeFile(join(this.rootDirectory, "run.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  }

  public async appendStep(step: object): Promise<void> {
    const path = join(this.rootDirectory, "steps.jsonl");
    await writeFile(path, `${JSON.stringify(step)}\n`, { encoding: "utf8", flag: "a" });
    const audit = join(this.rootDirectory, "audit.jsonl");
    const value = step as { description?: string; status?: string; index?: number };
    await writeFile(audit, `${JSON.stringify({ timestamp: new Date().toISOString(), actor: "appvanta-runner", action: "step", target: value.description, outcome: value.status ?? "unknown", metadata: { index: String(value.index ?? "") } })}\n`, { encoding: "utf8", flag: "a" });
  }

  public async saveObservation(label: string, observation: Observation): Promise<void> {
    await writeFile(join(this.rootDirectory, "ui", `${label}.json`), `${JSON.stringify(observation, null, 2)}\n`, "utf8");
  }

  public async savePlan(content: string): Promise<void> {
    await writeFile(join(this.rootDirectory, "plan.md"), content, "utf8");
  }
}
