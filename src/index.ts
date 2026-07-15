export type ConformanceResult = {
  error?: string;
  name: string;
  passed: boolean;
};

export type ConformanceReport = {
  failed: number;
  passed: number;
  results: ReadonlyArray<ConformanceResult>;
  suite: string;
};

export class ConformanceError extends Error {
  constructor(readonly report: ConformanceReport) {
    super(`${report.suite}: ${report.failed} conformance scenario(s) failed`);
    this.name = "ConformanceError";
  }
}

const scenario = async (name: string, run: () => Promise<void>) => {
  try {
    await run();
    return { name, passed: true } satisfies ConformanceResult;
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Unknown failure",
      name,
      passed: false,
    } satisfies ConformanceResult;
  }
};

const rejects = async (run: () => Promise<unknown>, expected?: string) => {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      expected !== undefined &&
      !message.toLowerCase().includes(expected.toLowerCase())
    )
      throw new Error(`Rejection did not mention ${expected}: ${message}`);
    return;
  }
  throw new Error("Operation unexpectedly succeeded");
};

const report = (suite: string, results: ReadonlyArray<ConformanceResult>) => ({
  failed: results.filter(({ passed }) => !passed).length,
  passed: results.filter(({ passed }) => passed).length,
  results,
  suite,
});

export type CapabilityRequest = {
  actorId: string;
  destination: string;
  operation: string;
};

export type CapabilityConformanceHarness = {
  issue: (options: {
    actorId: string;
    allowedOrigin: string;
    maximumUses: number;
    operations: ReadonlyArray<string>;
  }) => Promise<string>;
  use: (capabilityId: string, request: CapabilityRequest) => Promise<unknown>;
};

export const runCapabilityConformance = async (
  create: () =>
    Promise<CapabilityConformanceHarness> | CapabilityConformanceHarness,
) => {
  const results = await Promise.all([
    scenario("capability/replay", async () => {
      const harness = await create();
      const id = await harness.issue({
        actorId: "agent-a",
        allowedOrigin: "https://api.example",
        maximumUses: 1,
        operations: ["send"],
      });
      const request = {
        actorId: "agent-a",
        destination: "https://api.example/send",
        operation: "send",
      };
      await harness.use(id, request);
      await rejects(() => harness.use(id, request));
    }),
    scenario("capability/concurrent-maximum-use", async () => {
      const harness = await create();
      const id = await harness.issue({
        actorId: "agent-a",
        allowedOrigin: "https://api.example",
        maximumUses: 1,
        operations: ["send"],
      });
      const settled = await Promise.allSettled(
        Array.from({ length: 8 }, () =>
          harness.use(id, {
            actorId: "agent-a",
            destination: "https://api.example/send",
            operation: "send",
          }),
        ),
      );
      if (settled.filter(({ status }) => status === "fulfilled").length !== 1)
        throw new Error("Exactly one concurrent use must succeed");
    }),
    scenario("capability/confused-deputy", async () => {
      const harness = await create();
      const id = await harness.issue({
        actorId: "agent-a",
        allowedOrigin: "https://api.example",
        maximumUses: 1,
        operations: ["send"],
      });
      await rejects(
        () =>
          harness.use(id, {
            actorId: "agent-b",
            destination: "https://api.example/send",
            operation: "send",
          }),
        "actor",
      );
    }),
    scenario("capability/scope-escalation", async () => {
      const harness = await create();
      const id = await harness.issue({
        actorId: "agent-a",
        allowedOrigin: "https://api.example",
        maximumUses: 1,
        operations: ["send"],
      });
      await rejects(
        () =>
          harness.use(id, {
            actorId: "agent-a",
            destination: "https://api.example/delete",
            operation: "delete",
          }),
        "scope",
      );
    }),
    scenario("capability/lookalike-origin", async () => {
      const harness = await create();
      const id = await harness.issue({
        actorId: "agent-a",
        allowedOrigin: "https://api.example",
        maximumUses: 1,
        operations: ["send"],
      });
      await rejects(
        () =>
          harness.use(id, {
            actorId: "agent-a",
            destination: "https://api.example.evil.test/send",
            operation: "send",
          }),
        "destination",
      );
    }),
  ]);
  return report("agent-capability", results);
};

export type ActionConformanceHarness = {
  approve: (actionId: string) => Promise<void>;
  execute: (leaseId: string, options?: { fail?: boolean }) => Promise<unknown>;
  issueLease: (actionId: string) => Promise<string>;
  mutateInput: (actionId: string) => Promise<void>;
  request: (options?: { denied?: boolean }) => Promise<string>;
};

export const runActionConformance = async (
  create: () => Promise<ActionConformanceHarness> | ActionConformanceHarness,
) => {
  const results = await Promise.all([
    scenario("action/single-use-lease", async () => {
      const harness = await create();
      const actionId = await harness.request();
      const leaseId = await harness.issueLease(actionId);
      await harness.execute(leaseId);
      await rejects(() => harness.execute(leaseId));
    }),
    scenario("action/failed-execution-consumes-lease", async () => {
      const harness = await create();
      const actionId = await harness.request();
      const leaseId = await harness.issueLease(actionId);
      await rejects(() => harness.execute(leaseId, { fail: true }));
      await rejects(() => harness.execute(leaseId));
    }),
    scenario("action/denial-cannot-lease", async () => {
      const harness = await create();
      const actionId = await harness.request({ denied: true });
      await rejects(() => harness.issueLease(actionId), "denied");
    }),
    scenario("action/approval-input-binding", async () => {
      const harness = await create();
      const actionId = await harness.request({ denied: true });
      await harness.approve(actionId);
      await harness.mutateInput(actionId);
      await rejects(() => harness.issueLease(actionId), "bound");
    }),
  ]);
  return report("agent-action", results);
};

export type TaskConformanceHarness = {
  cancel: (taskId: string, actorId: string) => Promise<unknown>;
  create: (actorId: string) => Promise<string>;
  get: (taskId: string, actorId: string) => Promise<unknown>;
};

export const runTaskConformance = async (
  create: () => Promise<TaskConformanceHarness> | TaskConformanceHarness,
) => {
  const results = await Promise.all([
    scenario("task/owner-isolation", async () => {
      const harness = await create();
      const taskId = await harness.create("agent-a");
      await rejects(() => harness.get(taskId, "agent-b"));
      await rejects(() => harness.cancel(taskId, "agent-b"));
      await harness.get(taskId, "agent-a");
    }),
  ]);
  return report("agent-task", results);
};

export const assertConformance = (result: ConformanceReport) => {
  if (result.failed > 0) throw new ConformanceError(result);
  return result;
};

export const conformanceCatalog = [
  "action/single-use-lease",
  "action/failed-execution-consumes-lease",
  "action/denial-cannot-lease",
  "action/approval-input-binding",
  "capability/replay",
  "capability/concurrent-maximum-use",
  "capability/confused-deputy",
  "capability/scope-escalation",
  "capability/lookalike-origin",
  "task/owner-isolation",
] as const;
