import { describe, expect, it } from "vitest";
import { META_RUN_ID } from "./bot-home-identity.js";
import {
  applySwitchboardEnvelope,
  captureSwitchboardFromSseLine,
  switchboardCallHeaders,
  switchboardCallMeta,
} from "./switchboard-ids.js";

describe("switchboard id capture", () => {
  it("reads run_id from an SSE data line", () => {
    const sink = {};
    captureSwitchboardFromSseLine('data: {"switchboard":{"run_id":"abc-1","job_id":"job-9"}}', sink);
    expect(sink).toEqual({ runId: "abc-1", jobId: "job-9" });
  });

  it("ignores [DONE] and non-JSON", () => {
    const sink = {};
    captureSwitchboardFromSseLine("data: [DONE]", sink);
    captureSwitchboardFromSseLine("event: ping", sink);
    captureSwitchboardFromSseLine("data: not-json", sink);
    expect(sink).toEqual({});
  });

  it("overwrites with a later completion id", () => {
    const sink = { runId: "parent" };
    applySwitchboardEnvelope({ run_id: "child" }, sink);
    expect(sink.runId).toBe("child");
  });
});

describe("switchboard MCP forwarding", () => {
  it("omits meta and headers when the Broker id is absent", () => {
    expect(switchboardCallMeta({})).toBeUndefined();
    expect(switchboardCallHeaders(undefined)).toBeUndefined();
  });

  it("never uses an empty token", () => {
    expect(switchboardCallMeta({ runId: "  " })).toBeUndefined();
  });

  it("sends Broker ids, not a Rakazo run UUID, on _meta and headers", () => {
    const ids = { runId: "broker-r", jobId: "job-1" };
    expect(switchboardCallMeta(ids)).toEqual({
      [META_RUN_ID]: "broker-r",
      "dev.switchboard/job_id": "job-1",
    });
    expect(switchboardCallHeaders(ids)).toEqual({
      "x-switchboard-run-id": "broker-r",
      "x-switchboard-job-id": "job-1",
    });
  });
});
