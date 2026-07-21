import { describe, expect, test } from "bun:test";
import {
  createAgentCertification,
  assertConformance,
  runA2aConformance,
  runArazzoConformance,
  runCapabilityConformance,
  runControlConformance,
  runDurableExecutionBoundaryConformance,
  runEffectAdapterRegistryConformance,
  runEffectAdapterExecutionConformance,
  runEffectAdapterInstallationConformance,
  runExecutionConformance,
  runMcpConformance,
  runTaskConformance,
  runWebMcpConformance,
  type CapabilityConformanceHarness,
} from "../src";

const capabilityHarness = (): CapabilityConformanceHarness => {
  const capabilities = new Map<
    string,
    {
      actorId: string;
      origin: string;
      operations: ReadonlyArray<string>;
      remaining: number;
    }
  >();
  let lock = Promise.resolve();
  return {
    issue: async ({ actorId, allowedOrigin, maximumUses, operations }) => {
      const id = crypto.randomUUID();
      capabilities.set(id, {
        actorId,
        operations,
        origin: new URL(allowedOrigin).origin,
        remaining: maximumUses,
      });
      return id;
    },
    use: async (id, request) => {
      const previous = lock;
      let release = () => {};
      lock = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        const capability = capabilities.get(id);
        if (!capability) throw new Error("unknown capability");
        if (capability.actorId !== request.actorId)
          throw new Error("actor mismatch");
        if (!capability.operations.includes(request.operation))
          throw new Error("outside scope");
        if (new URL(request.destination).origin !== capability.origin)
          throw new Error("destination mismatch");
        if (capability.remaining < 1) throw new Error("replay");
        capability.remaining -= 1;
        return true;
      } finally {
        release();
      }
    },
  };
};

describe("agent conformance runners", () => {
  test("a safe capability implementation passes every adversarial case", async () => {
    const result = await runCapabilityConformance(capabilityHarness);
    expect(result.passed).toBe(5);
    expect(result.failed).toBe(0);
    expect(assertConformance(result)).toBe(result);
  });

  test("reports a task ownership vulnerability without hiding it", async () => {
    const result = await runTaskConformance(() => ({
      cancel: async () => true,
      create: async () => "task-1",
      get: async () => true,
    }));
    expect(result.failed).toBe(1);
    expect(() => assertConformance(result)).toThrow("conformance scenario");
  });

  test("covers execution quarantine and kill-switch ordering", async () => {
    const effects = new Map<string, string>();
    expect(
      (
        await runExecutionConformance(() => ({
          enqueue: async (key) => {
            if (!effects.has(key)) effects.set(key, "pending");
            return key;
          },
          run: async (id, outcome = "success") => {
            effects.set(id, outcome);
          },
          status: async (id) => effects.get(id) ?? "missing",
          reconcile: async (id) => {
            effects.set(id, "succeeded");
          },
        }))
      ).failed,
    ).toBe(0);
    let disabled = false;
    let observed = false;
    expect(
      (
        await runControlConformance(() => ({
          disabled: async () => disabled,
          revoke: async () => {
            disabled = true;
            observed = disabled;
          },
          sourceSawDisabled: () => observed,
        }))
      ).failed,
    ).toBe(0);
  });

  test("covers the complete durable execution boundary", async () => {
    const yes = async () => true;
    const result = await runDurableExecutionBoundaryConformance(() => ({
      concurrentDispatchExecutesOnce: yes,
      crashRecoveryCompletesOnce: yes,
      drainStopsClaimsUntilResume: yes,
      expiredLeaseRecoversOnce: yes,
      mutatedInputIsRejected: yes,
      replayIsRejected: yes,
      tenantInventoryIsIsolated: yes,
      unknownOutcomeRequiresReconciliation: yes,
    }));

    expect(result.failed).toBe(0);
    expect(result.passed).toBe(8);
  });

  test("covers certified effect adapter activation", async () => {
    const yes = async () => true;
    const result = await runEffectAdapterRegistryConformance(() => ({
      descriptorDriftDeactivates: yes,
      evidenceRevocationStopsExecution: yes,
      outOfScopeEffectIsRejected: yes,
      staleCertificationIsRejected: yes,
      uncertifiedActivationIsRejected: yes,
    }));

    expect(result.failed).toBe(0);
    expect(result.passed).toBe(5);
  });

  test("covers tenant-scoped effect adapter installations", async () => {
    const yes = async () => true;
    const result = await runEffectAdapterInstallationConformance(() => ({
      descriptorDriftStopsInstallation: yes,
      destinationAndCredentialScopeIsExact: yes,
      installationStartsDisabled: yes,
      spendRequiresBoundMandateAndBudget: yes,
      tenantCannotUseAnotherInstallation: yes,
    }));

    expect(result.failed).toBe(0);
    expect(result.passed).toBe(5);
  });

  test("covers installed effect adapter execution", async () => {
    const yes = async () => true;
    const result = await runEffectAdapterExecutionConformance(() => ({
      authorizationPrecedesCredentialResolution: yes,
      capabilityMismatchStopsExecution: yes,
      exactCredentialsAreResolved: yes,
      executionContextIsBound: yes,
      unknownOutcomeIsQuarantined: yes,
    }));

    expect(result.failed).toBe(0);
    expect(result.passed).toBe(5);
  });

  test("emits a deterministic signed certification artifact", async () => {
    const report = await runCapabilityConformance(capabilityHarness);
    const certificate = await createAgentCertification({
      subject: { name: "agent.example", version: "1.0.0" },
      reports: [report],
      issuedAt: "2026-07-15T00:00:00.000Z",
      sign: (digest) => ({ digest, kid: "release-key" }),
    });
    expect(certificate.passed).toBe(true);
    expect(certificate.digest).toStartWith("sha256:");
    expect(certificate.proof).toEqual({
      digest: certificate.digest,
      kid: "release-key",
    });
  });

  test("runs the accepted and emerging agent protocol profiles", async () => {
    const yes = async () => true;
    const reports = await Promise.all([
      runA2aConformance(() => ({
        crossCallerTaskHidden: yes,
        protocolVersionEnforced: yes,
        requiredExtensionEnforced: yes,
        terminalSubscriptionRejected: yes,
        unsafePushUrlRejected: yes,
      })),
      runMcpConformance(() => ({
        negotiatedVersionEnforced: yes,
        taskOwnerIsolation: yes,
        unknownSessionRejected: yes,
        unsafeElicitationUrlRejected: yes,
        urlElicitationRequiresCapability: yes,
      })),
      runArazzoConformance(() => ({
        cycleRejected: yes,
        dependenciesRespected: yes,
        insecureDiscoveryRejected: yes,
        policyRunsBeforeEffect: yes,
        unsupportedFailsBeforeEffect: yes,
      })),
      runWebMcpConformance(() => ({
        abortUnregisters: yes,
        crossOriginRestricted: yes,
        invalidInputDeniedBeforeEffect: yes,
        missingPolicyDenied: yes,
        poisonedMetadataRejected: yes,
      })),
    ]);
    expect(reports.map(({ failed }) => failed)).toEqual([0, 0, 0, 0]);
    expect(reports.map(({ passed }) => passed)).toEqual([5, 5, 5, 5]);
  });

  test("reports a standards vulnerability without hiding it", async () => {
    const yes = async () => true;
    const result = await runWebMcpConformance(() => ({
      abortUnregisters: yes,
      crossOriginRestricted: yes,
      invalidInputDeniedBeforeEffect: yes,
      missingPolicyDenied: async () => false,
      poisonedMetadataRejected: yes,
    }));
    expect(result.failed).toBe(1);
    expect(result.results.find(({ passed }) => !passed)?.name).toBe(
      "webmcp/default-deny",
    );
  });
});
