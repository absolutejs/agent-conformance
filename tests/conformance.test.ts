import { describe, expect, test } from "bun:test";
import {
  assertConformance,
  runCapabilityConformance,
  runControlConformance,
  runExecutionConformance,
  runTaskConformance,
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
});
