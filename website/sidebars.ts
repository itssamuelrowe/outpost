import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

/**
 * The documentation sidebar. It is ordered as a learning path: start with the
 * concepts, follow the tutorial, then dip into the how-to guides as needed.
 */
const sidebars: SidebarsConfig = {
  docs: [
    "introduction",
    {
      type: "category",
      label: "Getting Started",
      items: [
        "getting-started/what-is-durable-execution",
        "getting-started/do-you-need-this",
        "getting-started/quick-start",
      ],
    },
    {
      type: "category",
      label: "Core Concepts",
      items: [
        "concepts/workflows",
        "concepts/steps",
        "concepts/workflow-lifecycle",
        "concepts/functional-style",
        "concepts/branching-and-loops",
        "concepts/writing-deterministic-steps",
        "concepts/durable-sleep",
        "concepts/retries-and-backoff",
        "concepts/ambiguous-state-and-probes",
        "concepts/expirable-resources",
        "concepts/leases-and-fencing",
        "concepts/chaos-testing",
      ],
    },
    {
      type: "category",
      label: "Guides",
      items: [
        "guides/circuit-breakers",
        "guides/alerts",
      ],
    },
  ],
};

export default sidebars;
