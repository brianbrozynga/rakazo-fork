import { describe, expect, it } from "vitest";
import { resolveBotWorkspacePath } from "./computer-support.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { executeBotHomeTool } from "./bot-home-tools.js";
import { META_BOT_ID, META_RUN_ID, identityFromMeta } from "./bot-home-identity.js";
import { provisionPrepared } from "./sandbox-test-support.js";

const context = {
  operationId: "op",
  traceId: "tr",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

function prismaStub(computer: {
  id: string;
  homeKey: string;
  kind: string;
  providerRef: string;
  scope: string;
}) {
  return {
    bot: {
      findUnique: async () => ({
        id: "bot-1",
        spaceId: "space-1",
        userId: "user-1",
        computer: {
          ...computer,
          controlHolder: "none",
          controlLeaseId: null,
          controlLeaseExpiresAt: null,
        },
        thread: { id: "thread-1", groupId: null },
      }),
    },
    run: {
      findUnique: async () => ({
        spaceId: "space-1",
        userId: "user-1",
        threadId: "thread-1",
        thread: { groupId: null },
      }),
    },
    $transaction: async () => {
      throw new Error("unexpected transaction");
    },
  };
}

describe("executeBotHomeTool", () => {
  it("maps bot_id + relative path through resolveBotWorkspacePath", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "notes/result.txt")).toBe(
      "bots/bot-1/notes/result.txt",
    );
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "notes/result.txt")).toBe(
      "notes/result.txt",
    );
  });

  it("missing bot_id errors", async () => {
    const result = await executeBotHomeTool(
      { sandbox: new FakeSandboxProvider(), prisma: prismaStub({
        id: "c1",
        homeKey: "bot-1",
        kind: "fake",
        providerRef: "fake-bot-1",
        scope: "dedicated",
      }) as never },
      identityFromMeta({}),
      "write_file",
      { path: "a.txt", content: "x" },
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect((result.content[0] as { text: string }).text).toMatch(/bot_id/);
  });

  it("attach without run_id errors before sandbox I/O", async () => {
    const result = await executeBotHomeTool(
      { sandbox: new FakeSandboxProvider(), prisma: prismaStub({
        id: "c1",
        homeKey: "bot-1",
        kind: "fake",
        providerRef: "fake-bot-1",
        scope: "dedicated",
      }) as never },
      identityFromMeta({ [META_BOT_ID]: "bot-1" }),
      "attach_file",
      { path: "a.txt" },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/parent run/);
  });

  it("write_file then list_files on the provisioned computer", async () => {
    const sandbox = new FakeSandboxProvider();
    const computer = await provisionPrepared(sandbox, { botId: "bot-1", homePath: "/tmp/bot-1" }, context);
    const prisma = prismaStub({
      id: "c1",
      homeKey: "bot-1",
      kind: computer.kind,
      providerRef: computer.providerRef ?? computer.id,
      scope: "dedicated",
    });
    const identity = identityFromMeta({
      [META_BOT_ID]: "bot-1",
      [META_RUN_ID]: "rakazo-run-1",
    });
    const written = await executeBotHomeTool(
      { sandbox, prisma: prisma as never },
      identity,
      "write_file",
      { path: "notes.txt", content: "hello" },
    );
    expect(written.isError).toBeFalsy();
    const listed = await executeBotHomeTool(
      { sandbox, prisma: prisma as never },
      identity,
      "list_files",
      { path: "" },
    );
    expect((listed.content[0] as { text: string }).text).toContain("notes.txt");
  });
});
