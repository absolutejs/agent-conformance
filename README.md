# @absolutejs/agent-conformance

Provider-neutral adversarial test runners for AI agent security boundaries.
Adapters expose a tiny harness; the package attacks it with replay, concurrent
maximum-use races, confused-deputy identity, scope escalation, lookalike URL
origins, mutated approved inputs, denied lease issuance, failed-execution
replay, and task-owner isolation.

```ts
import {
  assertConformance,
  runCapabilityConformance,
} from "@absolutejs/agent-conformance";

const report = await runCapabilityConformance(() => yourHarness());
assertConformance(report); // throws with the complete report when any case fails
```

The runners return data rather than depending on a test framework, so they work
inside Bun test, Vitest, Jest, CI scripts, or provider certification jobs.

Implement only the harnesses relevant to your package:

- `ActionConformanceHarness` for approval binding and execution leases.
- `CapabilityConformanceHarness` for credential grants, delegations, spend
  mandates, or other bounded capabilities.
- `TaskConformanceHarness` for durable task ownership and cancellation.

## License

MIT
