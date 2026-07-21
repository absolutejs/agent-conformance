import { defineManifest, toolFactory } from "@absolutejs/manifest";
import { Type } from "@sinclair/typebox";
import { conformanceCatalog } from "./index";

type Catalog = { catalog: () => ReadonlyArray<string> };
const tool = toolFactory<Catalog>();

export const manifest = defineManifest<Record<never, never>, Catalog>()({
  contract: 2,
  discovery: {
    audiences: ["agent-hosts", "security-teams", "ci-systems"],
    intents: [
      "test agent authorization",
      "attack agent protocol boundaries",
      "test unknown effect recovery",
      "certify an agent host",
    ],
    keywords: [
      "agents",
      "conformance",
      "security",
      "replay",
      "authorization",
      "reconciliation",
      "ci",
    ],
    protocols: ["MCP", "A2A 1.0", "OAuth 2.0", "AuthZEN"],
  },
  identity: {
    accent: "#dc2626",
    category: "testing",
    description:
      "Adversarial conformance suites for agent authorization, execution leases, capability scope, replay, races, destinations, task ownership, and the A2A, MCP, Arazzo, and WebMCP standards.",
    docsUrl: "https://github.com/absolutejs/agent-conformance",
    name: "@absolutejs/agent-conformance",
    tagline: "Prove an agent boundary fails safely.",
  },
  settings: Type.Object({}),
  slots: {},
  tools: {
    agent_conformance_catalog: tool.runtime({
      annotations: { readOnlyHint: true },
      authorization: {
        effects: ["read"],
        requiredScopes: ["conformance:read"],
      },
      description:
        "List the adversarial agent security scenarios available in this package.",
      handler: (_input, runtime) => JSON.stringify(runtime.catalog()),
      input: Type.Object({}),
    }),
  },
  wiring: [
    {
      id: "default",
      server: {
        code: "const agentConformance = { catalog: () => conformanceCatalog };",
        imports: [
          {
            from: "@absolutejs/agent-conformance",
            names: ["conformanceCatalog"],
          },
        ],
        placement: "module-scope",
      },
      title: "Expose the agent conformance catalog",
    },
  ],
});

export const catalog = conformanceCatalog;
