import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { FileEvidenceStore } from "./evidence.js";
import type { Device, DeviceDriver, RunId, RunMetadata } from "./domain.js";
import { brand } from "./domain.js";

export interface RunContext {
  readonly id: RunId;
  readonly rootDirectory: string;
  readonly metadata: RunMetadata;
  readonly evidence: FileEvidenceStore;
  readonly driver: DeviceDriver;
  readonly device: Device;
}

export async function createRunContext(options: {
  readonly runsDirectory: string;
  readonly driver: DeviceDriver;
  readonly device: Device;
}): Promise<RunContext> {
  const id = brand< string, "RunId">(`${new Date().toISOString().replace(/[:.]/g, "-")}-${options.device.id.replace(/[^A-Za-z0-9_-]/g, '_')}-${randomUUID().slice(0, 8)}`);
  const rootDirectory = join(options.runsDirectory, id);
  await mkdir(rootDirectory, { recursive: true });
  const metadata: RunMetadata = {
    runId: id,
    startedAt: new Date().toISOString(),
    status: "planned",
    driver: options.driver.name,
  };
  const evidence = new FileEvidenceStore(rootDirectory);
  await evidence.initialize(metadata);
  return { id, rootDirectory, metadata, evidence, driver: options.driver, device: options.device };
}
