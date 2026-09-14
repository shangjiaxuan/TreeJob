import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { SERVICE_VERSION } from "./config.js";

const RegistrySchema = z.object({
  endpoint: z.string().url(),
  pid: z.number().int().positive(),
  dataDirectoryFingerprint: z.string().min(1),
  serviceVersion: z.string().min(1),
  startedAt: z.string().datetime(),
}).strict();

export type DaemonRegistry = z.infer<typeof RegistrySchema>;

export class DaemonRegistryOwner {
  private readonly lockDirectory: string;
  private readonly registryFile: string;
  private ownsLock = false;

  constructor(
    private readonly dataDirectory: string,
    runtimeDirectory = dataDirectory,
  ) {
    this.lockDirectory = join(runtimeDirectory, "daemon-v7.owner.lock");
    this.registryFile = join(runtimeDirectory, "daemon-v7.json");
  }

  acquire(): boolean {
    mkdirSync(dirname(this.lockDirectory), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        mkdirSync(this.lockDirectory);
        writeFileSync(join(this.lockDirectory, "owner.json"), JSON.stringify({ pid: process.pid }) + "\n");
        this.ownsLock = true;
        break;
      } catch {
        if (!this.reclaimStaleLock()) {
          return false;
        }
      }
    }

    if (!this.ownsLock) {
      return false;
    }

    this.removeRegistry();
    return true;
  }

  publish(endpoint: URL): void {
    if (!this.ownsLock) {
      throw new Error("only the registry owner may publish a daemon endpoint");
    }

    const document: DaemonRegistry = {
      endpoint: endpoint.toString(),
      pid: process.pid,
      dataDirectoryFingerprint: fingerprint(this.dataDirectory),
      serviceVersion: SERVICE_VERSION,
      startedAt: new Date().toISOString(),
    };
    writeFileSync(this.registryFile, JSON.stringify(RegistrySchema.parse(document)) + "\n");
  }

  close(): void {
    this.removeRegistry();
    this.releaseLock();
  }

  private read(): DaemonRegistry | null {
    if (!existsSync(this.registryFile)) {
      return null;
    }

    try {
      return RegistrySchema.parse(JSON.parse(readFileSync(this.registryFile, "utf8")));
    } catch {
      return null;
    }
  }

  private removeRegistry(): void {
    try {
      rmSync(this.registryFile, { force: true });
    } catch {
      // A partially removed registry is equivalent to no registry.
    }
  }

  private releaseLock(): void {
    if (!this.ownsLock) {
      return;
    }

    try {
      rmSync(this.lockDirectory, { recursive: true, force: true });
    } finally {
      this.ownsLock = false;
    }
  }

  private reclaimStaleLock(): boolean {
    const owner = this.readLockOwner();

    if (owner !== null && isAlive(owner.pid)) {
      return false;
    }

    try {
      rmSync(this.lockDirectory, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  private readLockOwner(): { pid: number } | null {
    const file = join(this.lockDirectory, "owner.json");

    if (!existsSync(file)) {
      return null;
    }

    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
      return typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0
        ? { pid: value.pid }
        : null;
    } catch {
      return null;
    }
  }
}

export class DaemonLaunchGate {
  private readonly lockFile: string;
  private ownsLock = false;

  constructor(runtimeDirectory: string) {
    this.lockFile = join(runtimeDirectory, "daemon-v7.launch.lock");
  }

  acquire(): boolean {
    mkdirSync(dirname(this.lockFile), { recursive: true });

    try {
      writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid }) + "\n", { flag: "wx" });
      this.ownsLock = true;
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    if (!this.ownsLock) {
      return;
    }

    try {
      unlinkSync(this.lockFile);
    } catch {
      // A missing launch gate is already released.
    } finally {
      this.ownsLock = false;
    }
  }
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
