import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

/**
 * The documentation sidebar. It is ordered as a learning path: start with the
 * core concepts, cover scheduling and the functional style, then finish with
 * the guides and advanced topics (how-to guides plus deeper dives such as
 * serialization, leases and fencing, and chaos testing).
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
                "getting-started/beyond-safe-writes",
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
                "concepts/child-workflows",
                "concepts/branching-and-loops",
                "concepts/writing-deterministic-steps",
                "concepts/deterministic-values",
                "concepts/retries-and-backoff",
                "concepts/ambiguous-state-and-probes",
                "concepts/expirable-resources",
            ],
        },
        {
            type: "category",
            label: "Scheduling",
            items: [
                "scheduling/scheduler-lifecycle",
                "scheduling/durable-sleep",
                "scheduling/durable-cron",
                "scheduling/durable-cron-patterns",
                "scheduling/backfill-and-update",
                "scheduling/schedule-ownership",
            ],
        },
        {
            type: "category",
            label: "Function style",
            items: [
                "function-style/functional-workflows",
                "function-style/functional-durable-cron",
            ],
        },
        {
            type: "category",
            label: "Advanced topics",
            items: [
                "guides/managing-workflows",
                "guides/circuit-breakers",
                "guides/alerts",
                "concepts/serialization",
                "concepts/leases-and-fencing",
                "concepts/chaos-testing",
            ],
        },
    ],
};

export default sidebars;
