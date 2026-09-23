import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  ArtifactStore,
  BrowserProvider,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_BYTES } from "@rakazo/contracts";
import { inferAttachmentMimeType, sandboxCommandTimeoutMs } from "@rakazo/core";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  parseComputerMode,
  type Prisma,
  type PrismaClient,
  type ThreadEvents,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { createBrowserProvider } from "./browser-provider-factory.js";
import {
  browserActFromTool,
  browserNavigateFromTool,
  browserSnapshotFromTool,
} from "./browser-tools.js";
import { BACKGROUND_WORK_LAUNCH } from "./computer-idle.js";
import { hasActiveComputerControl } from "./computer-control.js";
import { withComputerScreenAvailability } from "./computer-screens.js";
import {
  displayBotWorkspacePath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  toComputerRef,
} from "./computer-support.js";
import { observationToolResult, parseComputerActions } from "./computer-tools.js";
import { isProtectedComputerLifecycleCommand, PAGE_BROWSER_TOOL_NAMES } from "./executor.js";
import {
  assertPlotDataWithinLimits,
  PLOT_TOOL_GUIDE,
  type PlotSpec,
  parsePlotData,
  plotSvgToPng,
  renderPlotSpecToSvg,
  searchChartCatalog,
} from "./plot-tool.js";
import { getActiveTeachingSession } from "./teaching-session.js";
import { DESKTOP_HELD_FOR_TAKEOVER_MESSAGE } from "./takeover-resume.js";
import { attachWorkspaceFileToThread } from "./thread-artifacts.js";
import { textContentArg } from "./tool-text.js";
import {
  type BotHomeIdentity,
  BotHomeIdentityError,
  requireBotId,
  requireParentRun,
} from "./bot-home-identity.js";

export const BOT_HOME_TOOL_NAMES = [
  "write_file",
  "read_file",
  "list_files",
  "shell",
  "attach_file",
  "render_plot",
  "open_path",
  "launch_app",
  "computer_observe",
  "computer_act",
  "browser_navigate",
  "browser_snapshot",
  "browser_act",
] as const;

export type BotHomeToolName = (typeof BOT_HOME_TOOL_NAMES)[number];

const MAX_MODEL_FILE_BYTES = 250_000;

export type BotHomeMcpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export type BotHomeCallResult = {
  content: BotHomeMcpContent[];
  isError?: boolean;
};

export type BotHomeToolDeps = {
  sandbox: SandboxProvider;
  prisma: PrismaClient;
  artifacts?: ArtifactStore;
  events?: ThreadEvents;
  browser?: BrowserProvider;
};

type LoadedComputer = {
  computer: ComputerRef;
  computerMode: ReturnType<typeof parseComputerMode>;
  stored: {
    id: string;
    kind: string;
    controlHolder: string;
    controlLeaseId: string | null;
    controlLeaseExpiresAt: Date | null;
  };
  spaceId: string;
  userId: string;
  threadId: string;
  groupId: string | null;
  graphical: boolean;
};

export async function executeBotHomeTool(
  deps: BotHomeToolDeps,
  identity: BotHomeIdentity,
  name: string,
  args: Record<string, unknown>,
): Promise<BotHomeCallResult> {
  if (!BOT_HOME_TOOL_NAMES.includes(name as BotHomeToolName)) {
    return errorResult(`unknown bot-home tool ${name}`);
  }
  try {
    const botId = requireBotId(identity);
    if (name === "attach_file") requireParentRun(identity);
    const loaded = await loadComputer(deps, identity, botId);
    const context = adapterContext(identity, loaded);
    const result = await dispatch(deps, loaded, context, name as BotHomeToolName, args);
    return toCallResult(result);
  } catch (error) {
    if (error instanceof BotHomeIdentityError) return errorResult(error.message);
    const message = error instanceof Error ? error.message : String(error);
    getLogger().error(`bot-home ${name} failed: ${message}`);
    return errorResult(message);
  }
}

async function loadComputer(
  deps: BotHomeToolDeps,
  identity: BotHomeIdentity,
  botId: string,
): Promise<LoadedComputer> {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: botId },
    select: {
      id: true,
      spaceId: true,
      userId: true,
      computer: true,
      thread: { select: { id: true, groupId: true } },
    },
  });
  if (!bot) throw new BotHomeIdentityError(`unknown bot ${botId}`);
  if (!bot.computer) throw new Error("Bot has no computer");
  const stored = bot.computer;
  const computer = toComputerRef(stored);
  const computerMode = parseComputerMode(stored.scope);
  let threadId = identity.threadId || bot.thread?.id || "";
  let groupId = bot.thread?.groupId ?? null;
  let spaceId = identity.spaceId || bot.spaceId;
  let userId = identity.userId || bot.userId;
  if (identity.runId) {
    const run = await deps.prisma.run.findUnique({
      where: { id: identity.runId },
      select: {
        spaceId: true,
        userId: true,
        threadId: true,
        thread: { select: { groupId: true } },
      },
    });
    if (run) {
      spaceId = identity.spaceId || run.spaceId;
      userId = identity.userId || run.userId;
      threadId = identity.threadId || run.threadId;
      groupId = run.thread.groupId ?? groupId;
    }
  }
  return {
    computer,
    computerMode,
    stored: {
      id: stored.id,
      kind: stored.kind,
      controlHolder: stored.controlHolder,
      controlLeaseId: stored.controlLeaseId,
      controlLeaseExpiresAt: stored.controlLeaseExpiresAt,
    },
    spaceId,
    userId,
    threadId,
    groupId,
    graphical: deps.sandbox.describe().capabilities.graphical,
  };
}

function adapterContext(identity: BotHomeIdentity, loaded: LoadedComputer): AdapterContext {
  return {
    operationId: `bot-home:${randomUUID()}`,
    traceId: identity.runId || loaded.stored.id,
    spaceId: loaded.spaceId,
    userId: loaded.userId,
    botId: identity.botId,
    runId: identity.runId || undefined,
    signal: new AbortController().signal,
  };
}

async function dispatch(
  deps: BotHomeToolDeps,
  loaded: LoadedComputer,
  context: AdapterContext,
  name: BotHomeToolName,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { computer, computerMode } = loaded;
  const botId = context.botId ?? "";
  const heldForTakeover = hasActiveComputerControl(loaded.stored);
  const teachingBusy = async () =>
    Boolean(await getActiveTeachingSession(deps.prisma, loaded.spaceId, botId));

  if (name === "list_files") {
    const requestedPath = String(args.path ?? "");
    const entries = await deps.sandbox.listFiles(
      computer,
      resolveBotWorkspacePath(computerMode, botId, requestedPath),
      context,
    );
    return {
      path: requestedPath,
      entries: entries.map((entry) => ({
        ...entry,
        path: displayBotWorkspacePath(computerMode, botId, requestedPath, entry.path),
      })),
    };
  }
  if (name === "read_file") {
    const filePath = String(args.path ?? "");
    const storedPath = resolveBotWorkspacePath(computerMode, botId, filePath);
    let bytes: Uint8Array;
    try {
      bytes = await deps.sandbox.readFile(computer, storedPath, context, {
        maxBytes: MAX_MODEL_FILE_BYTES,
      });
    } catch (error) {
      if (error instanceof Error && /exceeds \d+ bytes/.test(error.message)) {
        return { error: "file is too large for model context", path: filePath };
      }
      throw error;
    }
    try {
      return {
        path: filePath,
        content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    } catch {
      return { error: "file is not UTF-8 text; use open_path to inspect it", path: filePath };
    }
  }
  if (name === "write_file") {
    const filePath = String(args.path ?? "notes/result.txt");
    const content = textContentArg(args.content, "");
    await deps.sandbox.writeFile(
      computer,
      {
        path: resolveBotWorkspacePath(computerMode, botId, filePath),
        content: new TextEncoder().encode(content),
      },
      context,
    );
    return { ok: true, path: filePath };
  }
  if (name === "shell") {
    const command = String(args.command ?? args.cmd ?? "");
    if (loaded.graphical && isProtectedComputerLifecycleCommand(command)) {
      return {
        error:
          "This command was not run: the desktop-protection guard detected a protected command or shell syntax it cannot inspect. Shell access is still available. For ordinary repository work, use direct commands with explicit paths, without sourcing or command substitution. Do not stop or restart browser/desktop processes.",
      };
    }
    const cwd = resolveBotWorkspaceCwd(
      computerMode,
      botId,
      args.cwd ? String(args.cwd) : undefined,
    );
    return runSandboxCommand(
      deps.sandbox,
      computer,
      [
        "bash",
        "-c",
        BACKGROUND_WORK_LAUNCH,
        "rakazo-background-launch",
        loaded.stored.id,
        identityRunId(context),
        randomUUID(),
        command,
      ],
      cwd,
      context,
    );
  }
  if (name === "attach_file") {
    return attachFile(deps, loaded, context, String(args.path ?? ""));
  }
  if (name === "render_plot") {
    return renderPlot(deps, loaded, context, args);
  }
  if (name === "computer_observe") {
    if (heldForTakeover) return { error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE };
    if (await teachingBusy()) {
      return { error: "Teaching is in progress. Stop teaching before using the computer." };
    }
    return computerScreenToolResult(async () =>
      formatObservation(await deps.sandbox.observe(computer, context)),
    );
  }
  if (name === "computer_act") {
    if (heldForTakeover) return { error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE };
    if (await teachingBusy()) {
      return { error: "Teaching is in progress. Stop teaching before using the computer." };
    }
    return computerScreenToolResult(async () => {
      const result = await deps.sandbox.act(
        computer,
        {
          actions: parseComputerActions(args.actions),
          observe: args.observe !== false,
          settleMs: Number(args.settle_ms ?? 350),
        },
        context,
      );
      return result.observation
        ? formatObservation(
            result.observation,
            `completed ${result.completed} computer action${result.completed === 1 ? "" : "s"}`,
          )
        : { ok: true, completed: result.completed };
    });
  }
  if (name === "open_path") {
    if (heldForTakeover) return { error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE };
    const requestedPath = String(args.path ?? "");
    return computerScreenToolResult(async () => {
      const result = await deps.sandbox.act(
        computer,
        {
          actions: [
            {
              kind: "open",
              path: /^https?:\/\//i.test(requestedPath)
                ? requestedPath
                : resolveBotWorkspacePath(computerMode, botId, requestedPath),
            },
          ],
          observe: true,
          settleMs: 600,
        },
        context,
      );
      return result.observation
        ? formatObservation(result.observation, `opened ${requestedPath}`)
        : { ok: true };
    });
  }
  if (name === "launch_app") {
    if (heldForTakeover) return { error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE };
    const application = String(args.application ?? "");
    return computerScreenToolResult(async () => {
      const result = await deps.sandbox.act(
        computer,
        {
          actions: [
            {
              kind: "launch",
              application,
              uri: args.uri ? String(args.uri) : undefined,
            },
          ],
          observe: true,
          settleMs: 600,
        },
        context,
      );
      return result.observation
        ? formatObservation(result.observation, `launched ${application}`)
        : { ok: true };
    });
  }
  if (PAGE_BROWSER_TOOL_NAMES.has(name)) {
    if (heldForTakeover) return { error: DESKTOP_HELD_FOR_TAKEOVER_MESSAGE };
    if (await teachingBusy()) {
      return { error: "Teaching is in progress. Stop teaching before using the computer." };
    }
    const browser = deps.browser ?? createBrowserProvider(undefined, { sandbox: deps.sandbox });
    const tool =
      name === "browser_navigate"
        ? browserNavigateFromTool
        : name === "browser_snapshot"
          ? browserSnapshotFromTool
          : browserActFromTool;
    return computerScreenToolResult(() => tool(browser, computer, context, args));
  }
  return { error: `unknown bot-home tool ${name}` };
}

function identityRunId(context: AdapterContext): string {
  return context.runId ?? "helper";
}

function formatObservation(
  observation: Parameters<typeof observationToolResult>[0],
  note?: string,
) {
  return observationToolResult(observation, note);
}

async function computerScreenToolResult(work: () => Promise<unknown>) {
  return withComputerScreenAvailability(work);
}

async function runSandboxCommand(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  argv: string[],
  cwd: string | undefined,
  context: AdapterContext,
) {
  let stdout = "";
  let stderr = "";
  let code = 0;
  for await (const event of sandbox.execute(
    computer,
    { argv, cwd, timeoutMs: sandboxCommandTimeoutMs() },
    context,
  )) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") code = event.code;
  }
  return { stdout, stderr, code };
}

async function attachFile(
  deps: BotHomeToolDeps,
  loaded: LoadedComputer,
  context: AdapterContext,
  filePath: string,
) {
  if (!deps.artifacts) return { error: "artifact storage unavailable", path: filePath };
  if (!context.runId) return { error: "attach_file requires parent run identity in _meta", path: filePath };
  const storedPath = resolveBotWorkspacePath(loaded.computerMode, context.botId ?? "", filePath);
  let bytes: Uint8Array;
  try {
    bytes = await deps.sandbox.readFile(loaded.computer, storedPath, context, {
      maxBytes: ATTACHMENT_MAX_BYTES,
    });
  } catch {
    return { error: "file not found or unreadable", path: filePath };
  }
  const mimeType = inferAttachmentMimeType(filePath);
  if (!mimeType) return { error: "unsupported attachment type", path: filePath };
  const attached = await attachWorkspaceFileToThread(
    { prisma: deps.prisma, artifacts: deps.artifacts },
    {
      spaceId: loaded.spaceId,
      userId: loaded.userId,
      botId: context.botId ?? "",
      groupId: loaded.groupId ?? undefined,
      runId: context.runId,
      filePath,
      bytes,
      operationId: context.operationId,
    },
  );
  await publishMessage(deps, loaded, context, [attached.block]);
  return { ok: true, artifactId: attached.artifactId, path: filePath };
}

async function renderPlot(
  deps: BotHomeToolDeps,
  loaded: LoadedComputer,
  context: AdapterContext,
  args: Record<string, unknown>,
) {
  const botId = context.botId ?? "";
  if (args.charts !== undefined) {
    const query = typeof args.charts === "string" ? args.charts : undefined;
    return {
      charts: searchChartCatalog(query),
      note: "Each spec is a complete runnable example: substitute your rows and column names, then call render_plot with it.",
    };
  }
  if (args.help === true || !args.spec || typeof args.spec !== "object") {
    return { guide: PLOT_TOOL_GUIDE };
  }
  let rows = Array.isArray(args.data) ? (args.data as unknown[]) : undefined;
  const dataPath = typeof args.data_path === "string" && args.data_path ? args.data_path : undefined;
  if (!rows && dataPath) {
    const bytes = await deps.sandbox.readFile(
      loaded.computer,
      resolveBotWorkspacePath(loaded.computerMode, botId, dataPath),
      context,
      { maxBytes: ATTACHMENT_MAX_BYTES },
    );
    rows = parsePlotData(dataPath, new TextDecoder().decode(bytes));
  }
  assertPlotDataWithinLimits(args.spec as PlotSpec, rows);
  const { JSDOM } = await import("jsdom");
  const svg = renderPlotSpecToSvg(args.spec as PlotSpec, rows, new JSDOM("").window.document);
  const png = await plotSvgToPng(svg);
  const outPath =
    typeof args.path === "string" && args.path ? args.path : `charts/plot-${Date.now()}.png`;
  await deps.sandbox.writeFile(
    loaded.computer,
    { path: resolveBotWorkspacePath(loaded.computerMode, botId, outPath), content: png },
    context,
  );
  let attached = false;
  const chartName = outPath.split("/").pop() ?? "chart";
  const chartRows = rows ?? (args.spec as { data?: unknown[] }).data ?? [];
  const chartSpec = { ...(args.spec as Record<string, unknown>) };
  delete chartSpec.data;
  const chartFits =
    Array.isArray(chartRows) && JSON.stringify({ spec: chartSpec, data: chartRows }).length <= 200_000;
  if (args.attach !== false && chartFits && context.runId) {
    await publishMessage(deps, loaded, context, [
      { kind: "chart", name: chartName, spec: chartSpec, data: chartRows },
    ]);
    attached = true;
  } else if (args.attach !== false && deps.artifacts && context.runId) {
    const result = await attachWorkspaceFileToThread(
      { prisma: deps.prisma, artifacts: deps.artifacts },
      {
        spaceId: loaded.spaceId,
        userId: loaded.userId,
        botId,
        runId: context.runId,
        filePath: outPath,
        bytes: png,
        operationId: context.operationId,
      },
    );
    await publishMessage(deps, loaded, context, [result.block]);
    attached = true;
  }
  return { ok: true, path: outPath, attached };
}

async function publishMessage(
  deps: BotHomeToolDeps,
  loaded: LoadedComputer,
  context: AdapterContext,
  blocks: MessageBlock[],
) {
  if (!context.runId || !loaded.threadId) {
    throw new BotHomeIdentityError("attach/plot requires parent run and thread identity in _meta");
  }
  const run = {
    id: context.runId,
    spaceId: loaded.spaceId,
    threadId: loaded.threadId,
    botId: context.botId ?? "",
  };
  const committed = await deps.prisma.$transaction((tx: Prisma.TransactionClient) =>
    persistMessageInTransaction(tx, run, blocks),
  );
  await deps.events?.notify(run.threadId, committed.eventSeq).catch((error) => {
    getLogger().error("bot-home thread message realtime notification", error);
  });
}

async function persistMessageInTransaction(
  tx: Prisma.TransactionClient,
  run: { id: string; spaceId: string; threadId: string; botId: string },
  blocks: MessageBlock[],
) {
  const message = await createThreadMessageInTransaction(tx, {
    threadId: run.threadId,
    role: "bot",
    blocks,
    botId: run.botId,
    runId: run.id,
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: run.spaceId,
    threadId: run.threadId,
    botId: run.botId,
    type: "thread.message.created",
    runId: run.id,
    payload: { messageId: message.id, role: "bot", blocks },
  });
  return { message, eventSeq: event.seq };
}

function errorResult(message: string): BotHomeCallResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function toCallResult(result: unknown): BotHomeCallResult {
  if (result && typeof result === "object" && (result as { kind?: string }).kind === "agent_tool_result") {
    const shaped = result as {
      content?: BotHomeMcpContent[];
      details?: unknown;
    };
    const content = Array.isArray(shaped.content) && shaped.content.length > 0
      ? shaped.content
      : [{ type: "text" as const, text: JSON.stringify(shaped.details ?? {}) }];
    return { content };
  }
  if (result && typeof result === "object" && "error" in result) {
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(result ?? {}) }],
  };
}
