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

export type EgressConformanceHarness = {
  request: (
    url: string,
    options?: { redirectTo?: string; credential?: string },
  ) => Promise<{ credentialSeen?: string }>;
};
export const runEgressConformance = async (
  create: () => Promise<EgressConformanceHarness> | EgressConformanceHarness,
) => {
  const results = await Promise.all([
    scenario("egress/private-network", async () => {
      const harness = await create();
      await rejects(() => harness.request("https://169.254.169.254/latest"));
    }),
    scenario("egress/lookalike-host", async () => {
      const harness = await create();
      await rejects(() => harness.request("https://api.example.com.evil.test"));
    }),
    scenario("egress/redirect-credential-isolation", async () => {
      const harness = await create();
      const result = await harness.request("https://api.example.com", {
        credential: "secret",
        redirectTo: "https://cdn.example.net",
      });
      if (result.credentialSeen !== undefined)
        throw new Error("Credential leaked across redirect");
    }),
  ]);
  return report("agent-egress", results);
};

export type ExecutionConformanceHarness = {
  enqueue: (idempotencyKey: string) => Promise<string>;
  reconcile: (effectId: string) => Promise<void>;
  run: (effectId: string, outcome?: "success" | "unknown") => Promise<void>;
  status: (effectId: string) => Promise<string>;
};
export const runExecutionConformance = async (
  create: () =>
    Promise<ExecutionConformanceHarness> | ExecutionConformanceHarness,
) => {
  const results = await Promise.all([
    scenario("execution/idempotent-enqueue", async () => {
      const h = await create();
      const [a, b] = await Promise.all([h.enqueue("same"), h.enqueue("same")]);
      if (a !== b) throw new Error("Duplicate effect created");
    }),
    scenario("execution/unknown-not-retried", async () => {
      const h = await create();
      const id = await h.enqueue("unknown");
      await h.run(id, "unknown");
      if ((await h.status(id)) !== "unknown")
        throw new Error("Unknown outcome was not quarantined");
      await h.reconcile(id);
    }),
  ]);
  return report("agent-execution", results);
};

export type DurableExecutionBoundaryConformanceHarness = {
  concurrentDispatchExecutesOnce: () => Promise<boolean>;
  crashRecoveryCompletesOnce: () => Promise<boolean>;
  drainStopsClaimsUntilResume: () => Promise<boolean>;
  expiredLeaseRecoversOnce: () => Promise<boolean>;
  mutatedInputIsRejected: () => Promise<boolean>;
  replayIsRejected: () => Promise<boolean>;
  tenantInventoryIsIsolated: () => Promise<boolean>;
  unknownOutcomeRequiresReconciliation: () => Promise<boolean>;
};

export const runDurableExecutionBoundaryConformance = async (
  create: () =>
    | DurableExecutionBoundaryConformanceHarness
    | Promise<DurableExecutionBoundaryConformanceHarness>,
) => {
  const check = async (
    name: string,
    assertion: keyof DurableExecutionBoundaryConformanceHarness,
    failure: string,
  ) =>
    scenario(name, async () => {
      if (!(await (await create())[assertion]())) throw new Error(failure);
    });

  return report("agent-durable-execution-boundary", [
    await check(
      "execution-boundary/replay",
      "replayIsRejected",
      "A completed effect executed again",
    ),
    await check(
      "execution-boundary/mutated-input",
      "mutatedInputIsRejected",
      "An effect executed with input that did not match its authorized digest",
    ),
    await check(
      "execution-boundary/tenant-inventory",
      "tenantInventoryIsIsolated",
      "An effect was visible through another tenant inventory",
    ),
    await check(
      "execution-boundary/concurrent-dispatch",
      "concurrentDispatchExecutesOnce",
      "Concurrent dispatch executed one durable effect more than once",
    ),
    await check(
      "execution-boundary/expired-lease",
      "expiredLeaseRecoversOnce",
      "An expired worker lease was lost or produced a duplicate effect",
    ),
    await check(
      "execution-boundary/crash-recovery",
      "crashRecoveryCompletesOnce",
      "A crash window lost or duplicated a durable effect",
    ),
    await check(
      "execution-boundary/unknown-outcome",
      "unknownOutcomeRequiresReconciliation",
      "An unknown provider outcome was retried without reconciliation",
    ),
    await check(
      "execution-boundary/drain-resume",
      "drainStopsClaimsUntilResume",
      "Drain accepted new work or resume failed to restore processing",
    ),
  ]);
};

export type EffectAdapterRegistryConformanceHarness = {
  descriptorDriftDeactivates: () => Promise<boolean>;
  evidenceRevocationStopsExecution: () => Promise<boolean>;
  outOfScopeEffectIsRejected: () => Promise<boolean>;
  staleCertificationIsRejected: () => Promise<boolean>;
  uncertifiedActivationIsRejected: () => Promise<boolean>;
};

export const runEffectAdapterRegistryConformance = async (
  create: () =>
    | EffectAdapterRegistryConformanceHarness
    | Promise<EffectAdapterRegistryConformanceHarness>,
) => {
  const check = async (
    name: string,
    assertion: keyof EffectAdapterRegistryConformanceHarness,
    failure: string,
  ) =>
    scenario(name, async () => {
      if (!(await (await create())[assertion]())) throw new Error(failure);
    });

  return report("agent-effect-adapter-registry", [
    await check(
      "adapter-registry/uncertified-activation",
      "uncertifiedActivationIsRejected",
      "An uncertified effect adapter activated",
    ),
    await check(
      "adapter-registry/descriptor-drift",
      "descriptorDriftDeactivates",
      "Descriptor drift retained certification or activation",
    ),
    await check(
      "adapter-registry/stale-certification",
      "staleCertificationIsRejected",
      "A stale adapter certificate activated",
    ),
    await check(
      "adapter-registry/effect-scope",
      "outOfScopeEffectIsRejected",
      "An adapter executed an undeclared effect",
    ),
    await check(
      "adapter-registry/evidence-revocation",
      "evidenceRevocationStopsExecution",
      "Execution continued after retained evidence became invalid",
    ),
  ]);
};

export type EffectAdapterInstallationConformanceHarness = {
  descriptorDriftStopsInstallation: () => Promise<boolean>;
  destinationAndCredentialScopeIsExact: () => Promise<boolean>;
  installationStartsDisabled: () => Promise<boolean>;
  spendRequiresBoundMandateAndBudget: () => Promise<boolean>;
  tenantCannotUseAnotherInstallation: () => Promise<boolean>;
};

export const runEffectAdapterInstallationConformance = async (
  create: () =>
    | EffectAdapterInstallationConformanceHarness
    | Promise<EffectAdapterInstallationConformanceHarness>,
) => {
  const check = async (
    name: string,
    assertion: keyof EffectAdapterInstallationConformanceHarness,
    failure: string,
  ) =>
    scenario(name, async () => {
      if (!(await (await create())[assertion]())) throw new Error(failure);
    });

  return report("agent-effect-adapter-installations", [
    await check(
      "adapter-installations/default-off",
      "installationStartsDisabled",
      "A newly configured tenant adapter installation executed before enablement",
    ),
    await check(
      "adapter-installations/tenant-fence",
      "tenantCannotUseAnotherInstallation",
      "A tenant used another tenant's effect adapter installation",
    ),
    await check(
      "adapter-installations/descriptor-drift",
      "descriptorDriftStopsInstallation",
      "A descriptor-pinned installation survived global adapter drift",
    ),
    await check(
      "adapter-installations/destination-credential-scope",
      "destinationAndCredentialScopeIsExact",
      "An installation escaped its destination or credential-alias scope",
    ),
    await check(
      "adapter-installations/spend-mandate-budget",
      "spendRequiresBoundMandateAndBudget",
      "An installation spent outside its bound mandate or per-effect ceiling",
    ),
  ]);
};

export type ControlConformanceHarness = {
  disabled: (agentId: string) => Promise<boolean>;
  revoke: (agentId: string) => Promise<void>;
  sourceSawDisabled: () => boolean;
};
export const runControlConformance = async (
  create: () => Promise<ControlConformanceHarness> | ControlConformanceHarness,
) =>
  report("agent-control", [
    await scenario("control/kill-switch-first", async () => {
      const h = await create();
      await h.revoke("agent-a");
      if (!h.sourceSawDisabled() || !(await h.disabled("agent-a")))
        throw new Error("Kill switch was not active before cleanup");
    }),
  ]);

export type DiscoveryConformanceHarness = {
  descriptor: () => Promise<unknown>;
  verify: (descriptor: unknown) => Promise<boolean>;
  tamper: (descriptor: unknown) => unknown;
  search: (query: string) => Promise<Array<{ id: string }>>;
};
export const runDiscoveryConformance = async (
  create: () =>
    DiscoveryConformanceHarness | Promise<DiscoveryConformanceHarness>,
) =>
  report("agent-discovery", [
    await scenario("discovery/signed-descriptor", async () => {
      const h = await create();
      const descriptor = await h.descriptor();
      if (!(await h.verify(descriptor)))
        throw new Error("Descriptor is invalid");
      if (await h.verify(h.tamper(descriptor)))
        throw new Error("Tampered descriptor verified");
    }),
    await scenario("discovery/deterministic-search", async () => {
      const h = await create();
      const first = await h.search("calendar scheduling");
      const second = await h.search("calendar scheduling");
      if (JSON.stringify(first) !== JSON.stringify(second))
        throw new Error("Search order is not deterministic");
      if (new Set(first.map(({ id }) => id)).size !== first.length)
        throw new Error("Search returned duplicate descriptors");
    }),
  ]);

export type DurableRuntimeConformanceHarness = {
  budgetDeniedBeforeEffect: () => Promise<boolean>;
  cancelBeforeWork: () => Promise<boolean>;
  recoverRequestedEffect: () => Promise<{
    executions: number;
    completed: boolean;
  }>;
};
export const runDurableRuntimeConformance = async (
  create: () =>
    | DurableRuntimeConformanceHarness
    | Promise<DurableRuntimeConformanceHarness>,
) =>
  report("agent-runtime", [
    await scenario("runtime/crash-recovery-idempotency", async () => {
      const result = await (await create()).recoverRequestedEffect();
      if (!result.completed || result.executions !== 1)
        throw new Error("Persisted effect was lost or executed more than once");
    }),
    await scenario("runtime/budget-fails-before-effect", async () => {
      if (!(await (await create()).budgetDeniedBeforeEffect()))
        throw new Error("Over-budget effect reached executor");
    }),
    await scenario("runtime/cancellation", async () => {
      if (!(await (await create()).cancelBeforeWork()))
        throw new Error("Cancelled run reached driver");
    }),
  ]);

export type TrustConformanceHarness = {
  externalInstructionDenied: () => Promise<boolean>;
  taintSurvivesDerivation: () => Promise<boolean>;
  secretDeniedAtActionSink: () => Promise<boolean>;
};
export const runTrustConformance = async (
  create: () => TrustConformanceHarness | Promise<TrustConformanceHarness>,
) =>
  report("agent-trust", [
    await scenario("trust/external-data-is-not-instruction", async () => {
      if (!(await (await create()).externalInstructionDenied()))
        throw new Error("External data gained instruction authority");
    }),
    await scenario("trust/taint-propagation", async () => {
      if (!(await (await create()).taintSurvivesDerivation()))
        throw new Error("Derived output lost taint");
    }),
    await scenario("trust/secret-action-sink", async () => {
      if (!(await (await create()).secretDeniedAtActionSink()))
        throw new Error("Secret reached action sink");
    }),
  ]);

export type MemoryConformanceHarness = {
  crossTenantDenied: () => Promise<boolean>;
  expiredInvisible: () => Promise<boolean>;
  eraseSubject: () => Promise<boolean>;
  poisonedWriteDenied: () => Promise<boolean>;
};
export const runMemoryConformance = async (
  create: () => MemoryConformanceHarness | Promise<MemoryConformanceHarness>,
) =>
  report("agent-memory", [
    await scenario("memory/cross-tenant", async () => {
      if (!(await (await create()).crossTenantDenied()))
        throw new Error("Cross-tenant memory read succeeded");
    }),
    await scenario("memory/expiration", async () => {
      if (!(await (await create()).expiredInvisible()))
        throw new Error("Expired memory remained visible");
    }),
    await scenario("memory/subject-erasure", async () => {
      if (!(await (await create()).eraseSubject()))
        throw new Error("Subject erasure incomplete");
    }),
    await scenario("memory/poisoning", async () => {
      if (!(await (await create()).poisonedWriteDenied()))
        throw new Error("Poisoned memory persisted");
    }),
  ]);

export type InboxConformanceHarness = {
  duplicateDeliveredOnce: () => Promise<boolean>;
  invalidSignatureDenied: () => Promise<boolean>;
  leaseRaceHasOneWinner: () => Promise<boolean>;
  scheduleCrashRecovered: () => Promise<boolean>;
};
export const runInboxConformance = async (
  create: () => InboxConformanceHarness | Promise<InboxConformanceHarness>,
) =>
  report("agent-inbox", [
    await scenario("inbox/signature", async () => {
      if (!(await (await create()).invalidSignatureDenied()))
        throw new Error("Invalid event was accepted");
    }),
    await scenario("inbox/deduplication", async () => {
      if (!(await (await create()).duplicateDeliveredOnce()))
        throw new Error("Duplicate event was delivered twice");
    }),
    await scenario("inbox/lease-race", async () => {
      if (!(await (await create()).leaseRaceHasOneWinner()))
        throw new Error("More than one worker won a lease");
    }),
    await scenario("inbox/schedule-crash", async () => {
      if (!(await (await create()).scheduleCrashRecovered()))
        throw new Error("Schedule occurrence was lost or duplicated");
    }),
  ]);

export type A2aConformanceHarness = {
  crossCallerTaskHidden: () => Promise<boolean>;
  requiredExtensionEnforced: () => Promise<boolean>;
  protocolVersionEnforced: () => Promise<boolean>;
  terminalSubscriptionRejected: () => Promise<boolean>;
  unsafePushUrlRejected: () => Promise<boolean>;
};
export const runA2aConformance = async (
  create: () => A2aConformanceHarness | Promise<A2aConformanceHarness>,
) =>
  report("a2a-1.0", [
    await scenario("a2a/protocol-version", async () => {
      if (!(await (await create()).protocolVersionEnforced()))
        throw new Error("A2A-Version was not enforced");
    }),
    await scenario("a2a/task-owner-isolation", async () => {
      if (!(await (await create()).crossCallerTaskHidden()))
        throw new Error("A2A task crossed an authorization boundary");
    }),
    await scenario("a2a/required-extension", async () => {
      if (!(await (await create()).requiredExtensionEnforced()))
        throw new Error("Required A2A extension was ignored");
    }),
    await scenario("a2a/terminal-subscription", async () => {
      if (!(await (await create()).terminalSubscriptionRejected()))
        throw new Error("Terminal A2A task accepted a subscription");
    }),
    await scenario("a2a/push-url", async () => {
      if (!(await (await create()).unsafePushUrlRejected()))
        throw new Error("Unsafe A2A push destination was accepted");
    }),
  ]);

export type McpConformanceHarness = {
  negotiatedVersionEnforced: () => Promise<boolean>;
  taskOwnerIsolation: () => Promise<boolean>;
  unknownSessionRejected: () => Promise<boolean>;
  unsafeElicitationUrlRejected: () => Promise<boolean>;
  urlElicitationRequiresCapability: () => Promise<boolean>;
};
export const runMcpConformance = async (
  create: () => McpConformanceHarness | Promise<McpConformanceHarness>,
) =>
  report("mcp-2025-11-25", [
    await scenario("mcp/negotiated-version", async () => {
      if (!(await (await create()).negotiatedVersionEnforced()))
        throw new Error("Negotiated MCP-Protocol-Version was not enforced");
    }),
    await scenario("mcp/session-binding", async () => {
      if (!(await (await create()).unknownSessionRejected()))
        throw new Error("Unknown MCP session was accepted");
    }),
    await scenario("mcp/task-owner-isolation", async () => {
      if (!(await (await create()).taskOwnerIsolation()))
        throw new Error("MCP task crossed an authorization boundary");
    }),
    await scenario("mcp/url-elicitation-capability", async () => {
      if (!(await (await create()).urlElicitationRequiresCapability()))
        throw new Error(
          "URL elicitation bypassed client capability negotiation",
        );
    }),
    await scenario("mcp/url-elicitation-destination", async () => {
      if (!(await (await create()).unsafeElicitationUrlRejected()))
        throw new Error("Unsafe URL elicitation destination was accepted");
    }),
  ]);

export type ArazzoConformanceHarness = {
  cycleRejected: () => Promise<boolean>;
  dependenciesRespected: () => Promise<boolean>;
  insecureDiscoveryRejected: () => Promise<boolean>;
  policyRunsBeforeEffect: () => Promise<boolean>;
  unsupportedFailsBeforeEffect: () => Promise<boolean>;
};
export const runArazzoConformance = async (
  create: () => ArazzoConformanceHarness | Promise<ArazzoConformanceHarness>,
) =>
  report("arazzo-1.1", [
    await scenario("arazzo/dependency-order", async () => {
      if (!(await (await create()).dependenciesRespected()))
        throw new Error("Arazzo explicit or implicit dependency was ignored");
    }),
    await scenario("arazzo/cycle", async () => {
      if (!(await (await create()).cycleRejected()))
        throw new Error("Cyclic Arazzo workflow was accepted");
    }),
    await scenario("arazzo/policy-before-effect", async () => {
      if (!(await (await create()).policyRunsBeforeEffect()))
        throw new Error("Arazzo effect ran before policy");
    }),
    await scenario("arazzo/unsupported-before-effect", async () => {
      if (!(await (await create()).unsupportedFailsBeforeEffect()))
        throw new Error("Unsupported Arazzo behavior partially executed");
    }),
    await scenario("arazzo/discovery-transport", async () => {
      if (!(await (await create()).insecureDiscoveryRejected()))
        throw new Error("Insecure Arazzo discovery was accepted");
    }),
  ]);

export type WebMcpConformanceHarness = {
  abortUnregisters: () => Promise<boolean>;
  crossOriginRestricted: () => Promise<boolean>;
  invalidInputDeniedBeforeEffect: () => Promise<boolean>;
  missingPolicyDenied: () => Promise<boolean>;
  poisonedMetadataRejected: () => Promise<boolean>;
};
export const runWebMcpConformance = async (
  create: () => WebMcpConformanceHarness | Promise<WebMcpConformanceHarness>,
) =>
  report("webmcp-2026-07-draft", [
    await scenario("webmcp/input-before-effect", async () => {
      if (!(await (await create()).invalidInputDeniedBeforeEffect()))
        throw new Error("Invalid WebMCP input reached a tool effect");
    }),
    await scenario("webmcp/default-deny", async () => {
      if (!(await (await create()).missingPolicyDenied()))
        throw new Error("WebMCP execution succeeded without policy");
    }),
    await scenario("webmcp/metadata-poisoning", async () => {
      if (!(await (await create()).poisonedMetadataRejected()))
        throw new Error("Poisoned WebMCP metadata was accepted");
    }),
    await scenario("webmcp/cross-origin", async () => {
      if (!(await (await create()).crossOriginRestricted()))
        throw new Error("Unsafe WebMCP exposedTo origin was accepted");
    }),
    await scenario("webmcp/abort-lifecycle", async () => {
      if (!(await (await create()).abortUnregisters()))
        throw new Error("Aborted WebMCP tool remained registered");
    }),
  ]);

export type AgentCertification = {
  subject: { name: string; version: string };
  profile: "absolutejs-agent-first-1";
  issuedAt: string;
  passed: boolean;
  reports: readonly ConformanceReport[];
  digest: string;
  proof?: unknown;
};
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
export const createAgentCertification = async (input: {
  subject: AgentCertification["subject"];
  reports: readonly ConformanceReport[];
  issuedAt?: string;
  sign?: (digest: string) => unknown | Promise<unknown>;
}): Promise<AgentCertification> => {
  const base = {
    subject: input.subject,
    profile: "absolutejs-agent-first-1" as const,
    issuedAt: input.issuedAt ?? new Date().toISOString(),
    passed: input.reports.every(({ failed }) => failed === 0),
    reports: input.reports,
  };
  const digest = `sha256:${Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stable(base)))).toString("hex")}`;
  return {
    ...base,
    digest,
    ...(input.sign ? { proof: await input.sign(digest) } : {}),
  };
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
  "egress/private-network",
  "egress/lookalike-host",
  "egress/redirect-credential-isolation",
  "execution/idempotent-enqueue",
  "execution/unknown-not-retried",
  "execution-boundary/replay",
  "execution-boundary/mutated-input",
  "execution-boundary/tenant-inventory",
  "execution-boundary/concurrent-dispatch",
  "execution-boundary/expired-lease",
  "execution-boundary/crash-recovery",
  "execution-boundary/unknown-outcome",
  "execution-boundary/drain-resume",
  "adapter-registry/uncertified-activation",
  "adapter-registry/descriptor-drift",
  "adapter-registry/stale-certification",
  "adapter-registry/effect-scope",
  "adapter-registry/evidence-revocation",
  "control/kill-switch-first",
  "discovery/signed-descriptor",
  "discovery/deterministic-search",
  "runtime/crash-recovery-idempotency",
  "runtime/budget-fails-before-effect",
  "runtime/cancellation",
  "trust/external-data-is-not-instruction",
  "trust/taint-propagation",
  "trust/secret-action-sink",
  "memory/cross-tenant",
  "memory/expiration",
  "memory/subject-erasure",
  "memory/poisoning",
  "inbox/signature",
  "inbox/deduplication",
  "inbox/lease-race",
  "inbox/schedule-crash",
  "a2a/protocol-version",
  "a2a/task-owner-isolation",
  "a2a/required-extension",
  "a2a/terminal-subscription",
  "a2a/push-url",
  "mcp/negotiated-version",
  "mcp/session-binding",
  "mcp/task-owner-isolation",
  "mcp/url-elicitation-capability",
  "mcp/url-elicitation-destination",
  "arazzo/dependency-order",
  "arazzo/cycle",
  "arazzo/policy-before-effect",
  "arazzo/unsupported-before-effect",
  "arazzo/discovery-transport",
  "webmcp/input-before-effect",
  "webmcp/default-deny",
  "webmcp/metadata-poisoning",
  "webmcp/cross-origin",
  "webmcp/abort-lifecycle",
] as const;
