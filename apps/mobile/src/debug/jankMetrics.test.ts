import { afterEach, describe, expect, it } from "vitest";
import {
  recordInvokeSent,
  recordPushHandled,
  setJankMetricsEnabled,
  setRemoteSessionStoreSizeSource,
  takeJankMetrics,
} from "./jankMetrics";
import { serializeMobileDebugRecord } from "./mobileDebugRecord";

const store = {
  sessionCount: 2,
  messageCount: 120,
  maxSessionMessageCount: 80,
  subscriberCount: 40,
  homeStatusSubscriberCount: 12,
  previewSubscriberCount: 30,
};

describe("jank metrics", () => {
  afterEach(() => setJankMetricsEnabled(false));

  it("records nothing while diagnostics are off", () => {
    recordPushHandled("local-db:messages:created", 5);
    setJankMetricsEnabled(true);
    expect(takeJankMetrics()).toMatchObject({
      pushCount: 0,
      invokeCount: 0,
      pushes: [],
      invokes: [],
    });
  });

  it("reports per-channel push time and request counts for one interval, then resets", () => {
    setJankMetricsEnabled(true);
    setRemoteSessionStoreSizeSource(() => store);
    recordPushHandled("maker:event", 1);
    recordPushHandled("local-db:messages:created", 4);
    recordPushHandled("local-db:messages:created", 10);
    recordInvokeSent("git-context:pr-status");
    recordInvokeSent("git-context:pr-status");

    expect(takeJankMetrics()).toEqual({
      store,
      pushCount: 3,
      pushMs: 15,
      pushes: [
        {
          channel: "local-db:messages:created",
          count: 2,
          totalMs: 14,
          maxMs: 10,
        },
        { channel: "maker:event", count: 1, totalMs: 1, maxMs: 1 },
      ],
      invokeCount: 2,
      invokes: [{ channel: "git-context:pr-status", count: 2 }],
    });
    expect(takeJankMetrics()).toMatchObject({ pushCount: 0, invokeCount: 0 });
  });

  it("keeps every number through the debug log redaction", () => {
    setJankMetricsEnabled(true);
    setRemoteSessionStoreSizeSource(() => store);
    // Channel names that look sensitive must not take their counts with them.
    recordPushHandled("auth:token-refreshed", 3);
    recordInvokeSent("local-db:messages:view");
    const line = serializeMobileDebugRecord("debug", "performance", [
      "jank metrics",
      takeJankMetrics(),
    ]);

    expect(line).not.toContain("[redacted]");
    expect(JSON.parse(line).args[1]).toMatchObject({
      store,
      pushes: [{ count: 1, totalMs: 3 }],
      invokes: [{ channel: "local-db:messages:view", count: 1 }],
    });
  });
});
