import { describe, expect, it } from "vitest";
import {
  identityFromMeta,
  META_BOT_ID,
  META_RUN_ID,
  META_THREAD_ID,
  overlayMeta,
  requireBotId,
  requireParentRun,
} from "./bot-home-identity.js";

describe("bot-home identity", () => {
  it("maps overlay _meta keys", () => {
    const identity = identityFromMeta({
      [META_BOT_ID]: "bot-1",
      [META_RUN_ID]: "run-1",
      [META_THREAD_ID]: "thread-1",
    });
    expect(identity).toEqual({
      botId: "bot-1",
      runId: "run-1",
      threadId: "thread-1",
      spaceId: "",
      userId: "",
    });
  });

  it("overlayMeta uses Switchboard keys", () => {
    expect(
      overlayMeta({ botId: "b", runId: "r", threadId: "t", spaceId: "s", userId: "u" }),
    ).toEqual({
      [META_BOT_ID]: "b",
      [META_RUN_ID]: "r",
      [META_THREAD_ID]: "t",
      "dev.switchboard/space_id": "s",
      "dev.switchboard/user_id": "u",
    });
  });

  it("missing bot_id is a loud error", () => {
    expect(() => requireBotId(identityFromMeta({}))).toThrow(/bot_id/);
  });

  it("attach without run_id is a loud error", () => {
    expect(() =>
      requireParentRun(identityFromMeta({ [META_BOT_ID]: "bot-1" })),
    ).toThrow(/parent run/);
  });
});
