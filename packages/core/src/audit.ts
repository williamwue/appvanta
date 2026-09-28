import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface AuditEvent { readonly timestamp: string; readonly actor: string; readonly action: string; readonly target?: string; readonly outcome: "started" | "passed" | "failed"; readonly metadata?: Readonly<Record<string, string>> }

export class AuditLog {
  public constructor(private readonly path: string) {}
  public async append(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
  }
}
