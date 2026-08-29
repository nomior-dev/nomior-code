import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { NomiorRequestError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { type NomiorCommandRunner, createRpcNomiorPort, whileConnecting } from "./rpcPort";

const succeed = <A>(value: A): Promise<AtomCommandResult<A, unknown>> =>
  Promise.resolve(AsyncResult.success(value));

const failWith = (message: string): Promise<AtomCommandResult<never, unknown>> =>
  Promise.resolve(
    AsyncResult.failure<never, unknown>(
      Cause.fail(new NomiorRequestError({ message, retryable: true })),
    ),
  );

/** Any call a test did not stub is a call it did not expect. */
const unstubbed = (call: string) => (): never => {
  throw new Error(`${call} was not stubbed`);
};

const baseRunner: NomiorCommandRunner = {
  listReviewJobs: unstubbed("listReviewJobs"),
  requestManualReview: unstubbed("requestManualReview"),
  searchContext: unstubbed("searchContext"),
  listMeetings: unstubbed("listMeetings"),
  getMeeting: unstubbed("getMeeting"),
  listConnectors: unstubbed("listConnectors"),
  setGoogleClientId: unstubbed("setGoogleClientId"),
  connectConnector: unstubbed("connectConnector"),
  disconnectConnector: unstubbed("disconnectConnector"),
  syncConnector: unstubbed("syncConnector"),
  listMemoryCandidates: unstubbed("listMemoryCandidates"),
  resolveMemoryCandidate: unstubbed("resolveMemoryCandidate"),
  listCalendarAccounts: unstubbed("listCalendarAccounts"),
  listCalendarEvents: unstubbed("listCalendarEvents"),
  listInstances: unstubbed("listInstances"),
  setInstancePinned: unstubbed("setInstancePinned"),
  getSchedulerState: unstubbed("getSchedulerState"),
  setAdvisoryMode: unstubbed("setAdvisoryMode"),
};

const reviewJob = {
  id: "job-1",
  repo: "nomior-dev/nomior-code",
  pullRequestNumber: 412,
  pullRequestTitle: "Add the review gate",
  riskTier: "high",
  status: "not-approved",
  verdict: "not-approved",
  severityCounts: { blocker: 2, major: 1, minor: 0 },
  manualReviewRequested: false,
  updatedAt: "2026-08-26T09:00:00.000Z",
} as const;

describe("RPC Nomior port reads", () => {
  it("is not a fixture port, so the sample-data badge stays off", () => {
    expect(createRpcNomiorPort(baseRunner).isFixture).toBe(false);
  });

  it("unwraps the review jobs envelope", async () => {
    const port = createRpcNomiorPort({
      ...baseRunner,
      listReviewJobs: () => succeed({ jobs: [reviewJob] }),
    });

    await expect(port.listReviewJobs()).resolves.toEqual([reviewJob]);
  });

  it("sends the trimmed query and unwraps the snippets envelope", async () => {
    const inputs: unknown[] = [];
    const snippet = {
      id: "snippet-1",
      sourceTitle: "Review engine deep dive",
      sourceKind: "meeting",
      sourceDate: "2026-08-24",
      excerpt: "The gate blocks on unresolved blockers.",
      score: 0.82,
    } as const;
    const port = createRpcNomiorPort({
      ...baseRunner,
      searchContext: (input) => {
        inputs.push(input);
        return succeed({ snippets: [snippet] });
      },
    });

    await expect(port.searchContext("review gate")).resolves.toEqual([snippet]);
    expect(inputs).toEqual([{ query: "review gate" }]);
  });

  it("unwraps the memory candidates envelope", async () => {
    const candidate = {
      id: "candidate-1",
      text: "Prefer receipts over sleeps in async tests.",
      source: "Review finding on #412",
      capturedAt: "2026-08-25T14:00:00.000Z",
      status: "pending",
    } as const;
    const port = createRpcNomiorPort({
      ...baseRunner,
      listMemoryCandidates: () => succeed({ candidates: [candidate] }),
    });

    await expect(port.listMemoryCandidates()).resolves.toEqual([candidate]);
  });

  it("passes the calendar window through and unwraps the events envelope", async () => {
    const inputs: unknown[] = [];
    const event = {
      id: "event-1",
      accountId: "account-1",
      title: "Daily standup",
      start: "2026-08-26T09:00:00.000Z",
      end: "2026-08-26T09:15:00.000Z",
      recurringSeriesId: "series-1",
      meeting: { meetingId: "meeting-1", hasTranscript: true, hasNotes: false },
    } as const;
    const port = createRpcNomiorPort({
      ...baseRunner,
      listCalendarAccounts: () =>
        succeed({ accounts: [{ id: "account-1", email: "ivan@example.com", colorIndex: 0 }] }),
      listCalendarEvents: (input) => {
        inputs.push(input);
        return succeed({ events: [event] });
      },
    });

    await expect(port.listCalendarAccounts()).resolves.toEqual([
      { id: "account-1", email: "ivan@example.com", colorIndex: 0 },
    ]);
    await expect(
      port.listCalendarEvents("2026-08-24T00:00:00.000Z", "2026-08-31T00:00:00.000Z"),
    ).resolves.toEqual([event]);
    expect(inputs).toEqual([
      { rangeStart: "2026-08-24T00:00:00.000Z", rangeEnd: "2026-08-31T00:00:00.000Z" },
    ]);
  });

  it("unwraps the instances envelope and passes the scheduler state through", async () => {
    const instance = {
      id: "instance-1",
      label: "Claude — work",
      provider: "Claude",
      health: "healthy",
      pinned: false,
      headroom: 0.64,
    } as const;
    const scheduler = {
      lastDecision: {
        instanceId: "instance-1",
        reason: "Highest rate-limit headroom (64%).",
        decidedAt: "2026-08-26T08:00:00.000Z",
      },
      advisoryMode: true,
    } as const;
    const port = createRpcNomiorPort({
      ...baseRunner,
      listInstances: () => succeed({ instances: [instance] }),
      getSchedulerState: () => succeed(scheduler),
    });

    await expect(port.listInstances()).resolves.toEqual([instance]);
    await expect(port.getSchedulerState()).resolves.toEqual(scheduler);
  });

  it("opens a context source without a wire call", async () => {
    await expect(createRpcNomiorPort(baseRunner).openContextSource("snippet-1")).resolves.toBe(
      undefined,
    );
  });
});

describe("RPC Nomior port writes", () => {
  it("names the job on a manual-review request", async () => {
    const inputs: unknown[] = [];
    const port = createRpcNomiorPort({
      ...baseRunner,
      requestManualReview: (input) => {
        inputs.push(input);
        return succeed(undefined);
      },
    });

    await port.requestManualReview("job-1");
    expect(inputs).toEqual([{ jobId: "job-1" }]);
  });

  it("carries the memory decision", async () => {
    const inputs: unknown[] = [];
    const port = createRpcNomiorPort({
      ...baseRunner,
      resolveMemoryCandidate: (input) => {
        inputs.push(input);
        return succeed(undefined);
      },
    });

    await port.resolveMemoryCandidate("candidate-1", "approved");
    expect(inputs).toEqual([{ id: "candidate-1", resolution: "approved" }]);
  });

  it("renames the instance id the wire expects", async () => {
    const inputs: unknown[] = [];
    const port = createRpcNomiorPort({
      ...baseRunner,
      setInstancePinned: (input) => {
        inputs.push(input);
        return succeed(undefined);
      },
      setAdvisoryMode: (input) => {
        inputs.push(input);
        return succeed(undefined);
      },
    });

    await port.setInstancePinned("instance-1", true);
    await port.setAdvisoryMode(false);
    expect(inputs).toEqual([{ instanceId: "instance-1", pinned: true }, { enabled: false }]);
  });
});

describe("RPC Nomior port failures", () => {
  it("rejects a read with the server's message instead of resolving empty", async () => {
    const port = createRpcNomiorPort({
      ...baseRunner,
      listReviewJobs: () => failWith("The review index is rebuilding."),
    });

    await expect(port.listReviewJobs()).rejects.toThrow("The review index is rebuilding.");
  });

  it("rejects a write with the server's message", async () => {
    const port = createRpcNomiorPort({
      ...baseRunner,
      setInstancePinned: () => failWith("Instance instance-9 is unknown."),
    });

    await expect(port.setInstancePinned("instance-9", true)).rejects.toThrow(
      "Instance instance-9 is unknown.",
    );
  });

  it("falls back to a generic message when the cause carries none", async () => {
    const port = createRpcNomiorPort({
      ...baseRunner,
      listInstances: () =>
        Promise.resolve(AsyncResult.failure<never, unknown>(Cause.fail("not an error"))),
    });

    await expect(port.listInstances()).rejects.toThrow("The Nomior request failed.");
  });
});

describe("whileConnecting", () => {
  /** Resolves to "pending" unless the port settled first. */
  const raceSettled = async (promise: Promise<unknown>) =>
    Promise.race([
      promise.then(
        () => "settled",
        () => "settled",
      ),
      new Promise((resolve) => setTimeout(() => resolve("pending"), 10)),
    ]);

  it("holds every read open instead of failing while the socket comes up", async () => {
    const port = whileConnecting(
      createRpcNomiorPort({
        ...baseRunner,
        listReviewJobs: () => failWith("Not connected."),
        searchContext: () => failWith("Not connected."),
        listMemoryCandidates: () => failWith("Not connected."),
        listCalendarAccounts: () => failWith("Not connected."),
        listCalendarEvents: () => failWith("Not connected."),
        listInstances: () => failWith("Not connected."),
        getSchedulerState: () => failWith("Not connected."),
      }),
    );

    const reads = [
      port.listReviewJobs(),
      port.searchContext("anything"),
      port.listMemoryCandidates(),
      port.listCalendarAccounts(),
      port.listCalendarEvents("2026-08-24T00:00:00.000Z", "2026-08-31T00:00:00.000Z"),
      port.listInstances(),
      port.getSchedulerState(),
    ];
    for (const read of reads) {
      expect(await raceSettled(read)).toBe("pending");
    }
  });

  it("still reports a write's real failure, and keeps the port live", async () => {
    const port = whileConnecting(
      createRpcNomiorPort({
        ...baseRunner,
        setInstancePinned: () => failWith("Instance instance-9 is unknown."),
      }),
    );

    expect(port.isFixture).toBe(false);
    await expect(port.setInstancePinned("instance-9", true)).rejects.toThrow(
      "Instance instance-9 is unknown.",
    );
  });
});
