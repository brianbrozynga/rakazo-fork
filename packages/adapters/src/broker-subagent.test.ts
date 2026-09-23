import { describe, expect, it } from "vitest";
import { META_BOT_ID, META_RUN_ID, META_THREAD_ID, overlayMeta } from "./bot-home-identity.js";
import { brokerWireName } from "./broker-subagent.js";

describe("brokerWireName", () => {
  it("strips Rakazo's mcp__{slug}__ prefix", () => {
    expect(brokerWireName("mcp__switchboard-work__run_subagent")).toBe("run_subagent");
    expect(brokerWireName("mcp__switchboard-work__helper_run")).toBe("helper_run");
  });

  it("passes a bare wire name through", () => {
    expect(brokerWireName("run_subagent")).toBe("run_subagent");
  });
});

describe("overlay _meta payload", () => {
  it("forwards bot, parent run, and thread ids", () => {
    expect(overlayMeta({ botId: "bot-9", runId: "run-9", threadId: "thread-9" })).toEqual({
      [META_BOT_ID]: "bot-9",
      [META_RUN_ID]: "run-9",
      [META_THREAD_ID]: "thread-9",
    });
  });
});
