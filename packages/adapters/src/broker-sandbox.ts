import type {
  AdapterContext,
  AdapterDescriptor,
  ComputerRef,
  PortableFile,
  SandboxCapabilities,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type {
  CommandRequest,
  ComputerActionRequest,
  ComputerActionResult,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ControlLeaseRef,
  PageBrowserCommand,
  PageBrowserResult,
  ProcessEvent,
  ScreenRequest,
  ScreenSession,
  SnapshotRef,
} from "@rakazo/adapter-kit";
import { createBrokerSession } from "./broker-mcp.js";

class UnsupportedOperation extends Error {
  constructor(op: string) {
    super(`BrokerSandboxProvider: ${op} is not supported (no computer in broker sandbox)`);
    this.name = "UnsupportedOperation";
  }
}

function textFromResult(result: { content?: unknown }): string {
  const content = result.content;
  if (Array.isArray(content) && content[0] && typeof content[0] === "object" && "text" in content[0]) {
    return String((content[0] as { text: unknown }).text);
  }
  return "";
}

/**
 * Pure-forwarding SandboxProvider that translates provider method calls into MCP tool
 * calls on broker's /sandbox/mcp/ endpoint. No fallback logic — caller handles that.
 *
 * execute: extracts argv[7] as the shell command (rakazo background-work-launch wrapper).
 * readFile / writeFile / listFiles: forwarded as read_file / write_file / list_files.
 * All other methods throw UnsupportedOperation.
 */
export class BrokerSandboxProvider implements SandboxProvider {
  constructor(
    private readonly sandboxMcpUrl: string,
    private readonly brokerMcpKey: string,
  ) {}

  describe(): AdapterDescriptor<SandboxCapabilities> {
    return {
      id: "broker-sandbox",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: {
        graphical: false,
        pty: false,
        snapshots: false,
        takeover: false,
        persistentHome: false,
      },
    };
  }

  async execute(
    _computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const command = request.argv[7] ?? request.argv.join(" ");
    const session = await createBrokerSession({
      url: this.sandboxMcpUrl,
      key: this.brokerMcpKey,
      signal: context.signal,
    });
    try {
      const result = await session.callTool("shell", {
        command,
        ...(request.cwd ? { cwd: request.cwd } : {}),
      });
      const text = textFromResult(result);
      return _eventsFromText(text, result.isError ? 1 : 0);
    } finally {
      void session.close().catch(() => undefined);
    }
  }

  async readFile(
    _computer: ComputerRef,
    path: string,
    context: AdapterContext,
  ): Promise<Uint8Array> {
    const session = await createBrokerSession({
      url: this.sandboxMcpUrl,
      key: this.brokerMcpKey,
      signal: context.signal,
    });
    try {
      const result = await session.callTool("read_file", { path });
      const text = textFromResult(result);
      return new TextEncoder().encode(text);
    } finally {
      void session.close().catch(() => undefined);
    }
  }

  async writeFile(
    _computer: ComputerRef,
    file: PortableFile,
    context: AdapterContext,
  ): Promise<void> {
    const content = new TextDecoder().decode(file.content);
    const session = await createBrokerSession({
      url: this.sandboxMcpUrl,
      key: this.brokerMcpKey,
      signal: context.signal,
    });
    try {
      await session.callTool("write_file", { path: file.path, content });
    } finally {
      void session.close().catch(() => undefined);
    }
  }

  async listFiles(
    _computer: ComputerRef,
    path: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const session = await createBrokerSession({
      url: this.sandboxMcpUrl,
      key: this.brokerMcpKey,
      signal: context.signal,
    });
    try {
      const result = await session.callTool("list_files", { path });
      const text = textFromResult(result);
      let entries: string[] = [];
      try {
        const parsed = JSON.parse(text) as { entries?: string[] };
        entries = parsed.entries ?? [];
      } catch {
        entries = text.split("\n").filter(Boolean);
      }
      return entries.map((name) => ({
        path: name,
        kind: name.endsWith("/") ? "dir" : "file",
        size: 0,
      }));
    } finally {
      void session.close().catch(() => undefined);
    }
  }

  provision(): Promise<ComputerRef> {
    throw new UnsupportedOperation("provision");
  }

  prepare(): Promise<void> {
    throw new UnsupportedOperation("prepare");
  }

  connectScreen(): Promise<ScreenSession> {
    throw new UnsupportedOperation("connectScreen");
  }

  sendInput(): Promise<void> {
    throw new UnsupportedOperation("sendInput");
  }

  observe(): Promise<ComputerObservation> {
    throw new UnsupportedOperation("observe");
  }

  act(): Promise<ComputerActionResult> {
    throw new UnsupportedOperation("act");
  }

  exportWorkspace(): AsyncIterable<PortableFile> {
    throw new UnsupportedOperation("exportWorkspace");
  }

  importWorkspace(): Promise<void> {
    throw new UnsupportedOperation("importWorkspace");
  }

  snapshot(): Promise<SnapshotRef> {
    throw new UnsupportedOperation("snapshot");
  }

  stop(): Promise<void> {
    throw new UnsupportedOperation("stop");
  }

  destroy(): Promise<void> {
    throw new UnsupportedOperation("destroy");
  }
}

async function* _eventsFromText(text: string, exitCode: number): AsyncIterable<ProcessEvent> {
  yield { type: "stdout", data: text };
  yield { type: "exit", code: exitCode };
}
