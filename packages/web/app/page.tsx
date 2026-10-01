import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import CardContent from "@mui/material/CardContent";
import Container from "@mui/material/Container";
import Grid from "@mui/material/Grid2";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

import BoltOutlinedIcon from "@mui/icons-material/BoltOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import ReplayOutlinedIcon from "@mui/icons-material/ReplayOutlined";
import StorageOutlinedIcon from "@mui/icons-material/StorageOutlined";
import HistoryToggleOffOutlinedIcon from "@mui/icons-material/HistoryToggleOffOutlined";
import ExtensionOutlinedIcon from "@mui/icons-material/ExtensionOutlined";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";
import TravelExploreOutlinedIcon from "@mui/icons-material/TravelExploreOutlined";
import VerifiedOutlinedIcon from "@mui/icons-material/VerifiedOutlined";
import LayersOutlinedIcon from "@mui/icons-material/LayersOutlined";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import GitHubIcon from "@mui/icons-material/GitHub";
import MenuBookOutlinedIcon from "@mui/icons-material/MenuBookOutlined";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";
import CloudSyncOutlinedIcon from "@mui/icons-material/CloudSyncOutlined";
import NotificationsActiveOutlinedIcon from "@mui/icons-material/NotificationsActiveOutlined";
import ScienceOutlinedIcon from "@mui/icons-material/ScienceOutlined";
import ShieldOutlinedIcon from "@mui/icons-material/ShieldOutlined";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import BedtimeOutlinedIcon from "@mui/icons-material/BedtimeOutlined";
import AccountTreeOutlinedIcon from "@mui/icons-material/AccountTreeOutlined";
import ReceiptLongOutlinedIcon from "@mui/icons-material/ReceiptLongOutlined";
import CallSplitOutlinedIcon from "@mui/icons-material/CallSplitOutlined";

import NavBar from "./components/NavBar";
import CodeBlock from "./components/CodeBlock";
import {
    CardTitle,
    CenteredMuted,
    CodeFrame,
    CtaContainer,
    CtaHeadline,
    CtaLede,
    CtaSection,
    DocsButton,
    Footer,
    FullHeightCard,
    GuaranteeIcon,
    HeadStack,
    HeroChip,
    HeroContainer,
    HeroHeadline,
    HeroLede,
    HeroSection,
    HighlightIcon,
    HighlightItem,
    HighlightRow,
    InlineCode,
    LimitDivider,
    LimitIcon,
    LimitsHeading,
    MutedBody,
    MutedBodyLast,
    MutedCaption,
    NarrowCenteredMuted,
    PackageIcon,
    PackageName,
    PaperSection,
    ProblemChip,
    Section,
    SectionHeading,
    SectionIconFrame,
    WhyBadge,
    WhySummary,
    WhyTitle,
} from "./page.styles";

interface SectionIconProps {
    icon: React.ReactNode;
    align?: "center" | "left";
}

interface FeatureCard {
    icon: React.ReactNode;
    title: string;
    body: string;
}

interface PackageCard {
    name: string;
    desc: string;
    icon: React.ReactNode;
}

interface HeroHighlight {
    icon: React.ReactNode;
    label: string;
}

/**
 * A framed accent icon used to anchor section headings.
 */
function SectionIcon({ icon, align = "center" }: SectionIconProps) {
    return <SectionIconFrame align={align}>{icon}</SectionIconFrame>;
}

const probeExample = `@Workflow({ id: "process-order" })
class ProcessOrder {
  @Step({
    id: "create-order",
    maxAttempts: 4,
    // A timeout or 5xx is ambiguous: the write may have landed.
    classifyError: (error) =>
      isTimeoutOr5xx(error) ? FailureKind.AMBIGUOUS : FailureKind.DEFINITE,
  })
  async createOrder(ctx: StepContext, input: OrderInput) {
    return shopify.orders.create({ ...input.order, tags: [ctx.workflowIdentifier] });
  }

  // On recovery, look before you leap.
  @Probe({ for: "create-order" })
  async findExistingOrder(ctx: StepContext) {
    const [existing] = await shopify.orders.search({ tag: ctx.workflowIdentifier });
    return existing ?? null; // non-null => already created, skip re-run
  }
}`;

const quickStart = `import { Workflow, Step, WorkflowEngine } from "@outpost/core";
import { MysqlStorage } from "@outpost/storage-mysql";

@Workflow({ id: "process-order" })
class ProcessOrder {
  @Step({ id: "charge-card", maxAttempts: 4, backoff: { baseMs: 1000, maxMs: 15_000, factor: 2 } })
  async chargeCard(ctx: StepContext, input: OrderInput) {
    return paymentGateway.charge(input.userId, input.amount);
  }

  @Step({ id: "fulfill-order", maxAttempts: 3 })
  async fulfillOrder(ctx: StepContext, input: OrderInput) {
    return warehouse.dispatch(input.orderId);
  }

  // The lifecycle function arranges ordinary control flow between durable steps.
  async run(ctx: WorkflowContext, input: OrderInput) {
    const payment = await this.chargeCard(ctx, input);
    await ctx.sleep("cooling-period", 2 * 60 * 60 * 1000); // durable
    const fulfillment = await this.fulfillOrder(ctx, input);
    return { paymentId: payment.id, tracking: fulfillment.tracking };
  }
}

const engine = new WorkflowEngine(
  new MysqlStorage({ connectionString: process.env.DATABASE_URL }),
);
engine.register(ProcessOrder);

// Re-running the same identifier resumes from the last committed step.
await engine.run("process-order", \`order-\${orderId}\`, orderInput);`;

const guarantees: FeatureCard[] = [
    {
        icon: <ReplayOutlinedIcon />,
        title: "Step memoization",
        body: "A committed step returns its stored output instead of running again on resume.",
    },
    {
        icon: <LockOutlinedIcon />,
        title: "Atomic claim and lease",
        body: "Two workers can never both hold a live lease on the same step under the adapter's atomic semantics.",
    },
    {
        icon: <BoltOutlinedIcon />,
        title: "Stale-worker fencing",
        body: "A worker that wakes after losing its lease cannot overwrite a newer owner's result.",
    },
    {
        icon: <HistoryToggleOffOutlinedIcon />,
        title: "Durable sleep",
        body: "Timers survive process restarts and resume via the embedded scheduler.",
    },
    {
        icon: <StorageOutlinedIcon />,
        title: "Pluggable storage",
        body: "The engine depends on a narrow storage contract. MySQL ships first; other backends slot in behind the same interface.",
    },
    {
        icon: <ExtensionOutlinedIcon />,
        title: "Modular plugins",
        body: "Circuit breakers, alerts, and chaos testing live outside the core so it stays small.",
    },
];

const packages: PackageCard[] = [
    {
        name: "@outpost/core",
        desc: "Execution, leasing, ambiguous-state resolution, middleware, audit",
        icon: <HubOutlinedIcon />,
    },
    {
        name: "@outpost/storage-mysql",
        desc: "MySQL / InnoDB reference storage adapter",
        icon: <StorageOutlinedIcon />,
    },
    {
        name: "@outpost/transport-sqs",
        desc: "First-party SQS consumer and publisher; transport stays out of core",
        icon: <CloudSyncOutlinedIcon />,
    },
    {
        name: "@outpost/plugin-resilience",
        desc: "Circuit breaker middleware and backoff helpers",
        icon: <ShieldOutlinedIcon />,
    },
    {
        name: "@outpost/plugin-alerts",
        desc: "Vendor-neutral alert hooks: webhook, Slack, PagerDuty",
        icon: <NotificationsActiveOutlinedIcon />,
    },
    {
        name: "@outpost/plugin-chaos",
        desc: "Deterministic fault injection: crashes, transient failures, lease expiry",
        icon: <ScienceOutlinedIcon />,
    },
];

const heroHighlights: HeroHighlight[] = [
    { icon: <TravelExploreOutlinedIcon fontSize="small" />, label: "Probe-first recovery" },
    { icon: <VerifiedOutlinedIcon fontSize="small" />, label: "Idempotent by design" },
    { icon: <LayersOutlinedIcon fontSize="small" />, label: "Runs in your process" },
];

/**
 * The "do you even need this?" reasons. These make the case that idempotency
 * keys and a DB transaction get you one safe write, but not a resumable,
 * multi-step, testable process.
 */
const whyReasons: FeatureCard[] = [
    {
        icon: <BedtimeOutlinedIcon />,
        title: "Durable sleeps that outlive the process",
        body: "Wait two hours, then resume, even if the process that started the workflow is long gone. A transaction can't hold a lock for two hours, and a cron job re-derives state you already had. Outpost persists the timer and wakes the workflow where it left off.",
    },
    {
        icon: <AccountTreeOutlinedIcon />,
        title: "Multi-step recovery, not one atomic write",
        body: "A DB transaction makes a single local write atomic. It does nothing for a five-step process that calls three external systems. Outpost checkpoints each step so a crash on step four resumes at step four, without redoing the charge on step one.",
    },
    {
        icon: <ScienceOutlinedIcon />,
        title: "Chaos testing your recovery paths",
        body: "You can write an idempotency key, but have you proven it holds when the process dies in the commit window? The chaos plugin injects crashes, transient failures, and lease expiry deterministically, so your recovery code is tested, not hoped for.",
    },
    {
        icon: <ReplayOutlinedIcon />,
        title: "Retries and backoff you don't hand-roll",
        body: "Idempotency keys make a retry safe. They don't schedule it. Outpost gives you per-step attempt budgets, exponential backoff, and full jitter, with the retry state persisted so it survives a restart.",
    },
    {
        icon: <ReceiptLongOutlinedIcon />,
        title: "An audit trail of what actually happened",
        body: "When an order goes wrong at 2am, transactions leave you grepping logs. Outpost records an immutable event for every material transition: started, completed, retried, failed, probed, so you can see exactly where a workflow stalled.",
    },
    {
        icon: <CallSplitOutlinedIcon />,
        title: "Optional and deferred work, first-class",
        body: "Fraud scoring shouldn't block checkout. A Salesforce sync shouldn't sit on the critical path. Optional steps fall back on failure and deferred steps run independently, without you wiring up a second queue and its own retry logic.",
    },
];

const limits = [
    "Exactly-once external side effects are not guaranteed. The probe pattern resolves the ambiguous window honestly, but it does not eliminate the underlying distributed-transaction problem.",
    "Circuit breaker state is process-local, not fleet-wide dependency health.",
    "The scheduler polls the storage backend, which is designed for moderate timer volumes rather than millions of concurrent timers.",
    "No deterministic replay. Durability applies at explicit ctx.step(...) boundaries, not to arbitrary control flow.",
];

export default async function Home() {
    const probeBlock = await CodeBlock({ filename: "create-order.ts", code: probeExample });
    const quickStartBlock = await CodeBlock({ filename: "process-order.ts", code: quickStart });

    return (
        <Box>
            <NavBar />

            {/* Hero */}
            <HeroSection>
                <HeroContainer maxWidth="lg">
                    <Stack spacing={4} alignItems="center" textAlign="center">
                        <HeroChip
                            label="Durable execution · embeddable · no cluster"
                            variant="outlined"
                        />
                        <HeroHeadline variant="h1">
                            Stop doing it twice when the API says it failed.
                        </HeroHeadline>
                        <HeroLede variant="h6">
                            Outpost is an embeddable durable execution library that resolves the
                            ambiguous-failure window, the moment when your call returns a 5xx but
                            the write actually succeeded. It runs inside your app process and
                            coordinates through your own database. No orchestrator, no daemon, no
                            cluster.
                        </HeroLede>
                        <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
                            <Button
                                variant="contained"
                                size="large"
                                href="#how"
                                endIcon={<ArrowForwardIcon />}
                            >
                                See how it works
                            </Button>
                            <DocsButton
                                variant="outlined"
                                size="large"
                                href="https://github.com"
                                target="_blank"
                                rel="noopener"
                                startIcon={<MenuBookOutlinedIcon />}
                            >
                                Read the docs
                            </DocsButton>
                        </Stack>

                        <HighlightRow
                            direction={{ xs: "column", sm: "row" }}
                            spacing={{ xs: 1, sm: 3 }}
                            justifyContent="center"
                        >
                            {heroHighlights.map((h) => (
                                <HighlightItem
                                    key={h.label}
                                    direction="row"
                                    spacing={0.75}
                                    alignItems="center"
                                >
                                    <HighlightIcon>{h.icon}</HighlightIcon>
                                    <Typography variant="body2">{h.label}</Typography>
                                </HighlightItem>
                            ))}
                        </HighlightRow>

                        <MutedCaption variant="body2">
                            Ships for Node and MySQL today. Built to grow language and storage
                            agnostic.
                        </MutedCaption>
                    </Stack>
                </HeroContainer>
            </HeroSection>

            {/* Problem */}
            <Section id="problem" maxWidth="lg">
                <Grid container spacing={6} alignItems="center">
                    <Grid size={{ xs: 12, md: 5 }}>
                        <ProblemChip
                            icon={<WarningAmberOutlinedIcon />}
                            label="The ambiguous-failure window"
                        />
                        <SectionHeading variant="h3">The 5xx that already succeeded</SectionHeading>
                        <MutedBody>
                            You call a payment provider or Shopify. It returns a 504. Did the charge
                            go through? Did the order get created? You genuinely don&apos;t know.
                        </MutedBody>
                        <MutedBodyLast>
                            Your queue redelivers. Your retry fires again. Now you&apos;ve charged
                            the card twice. Idempotency keys alone don&apos;t close this window,
                            because the failure happened between the side effect and your durable
                            commit. Outpost treats this as a first-class case. It records the step
                            as <InlineCode>AMBIGUOUS</InlineCode> and{" "}
                            <strong>probes before it re-executes</strong>.
                        </MutedBodyLast>
                    </Grid>
                    <Grid size={{ xs: 12, md: 7 }}>{probeBlock}</Grid>
                </Grid>
            </Section>

            {/* Do you even need this? */}
            <PaperSection id="why">
                <Container maxWidth="lg">
                    <HeadStack spacing={2} alignItems="center">
                        <SectionIcon icon={<HelpOutlineIcon />} />
                        <Typography variant="h3">
                            &ldquo;I already have idempotency keys and transactions.&rdquo;
                        </Typography>
                        <CenteredMuted>
                            Good, keep them. An idempotency key makes a single retry safe and a
                            transaction makes a single local write atomic. Neither one resumes a
                            multi-step process after a crash, waits two hours and picks up where it
                            left off, or lets you prove your recovery paths actually work. That is
                            the gap Outpost fills.
                        </CenteredMuted>
                    </HeadStack>

                    <Grid container spacing={3}>
                        {whyReasons.map((reason) => (
                            <Grid key={reason.title} size={{ xs: 12, md: 6 }}>
                                <FullHeightCard>
                                    <CardContent>
                                        <Stack direction="row" spacing={2} alignItems="flex-start">
                                            <WhyBadge>{reason.icon}</WhyBadge>
                                            <Box>
                                                <WhyTitle variant="h6">{reason.title}</WhyTitle>
                                                <MutedBodyLast variant="body2">
                                                    {reason.body}
                                                </MutedBodyLast>
                                            </Box>
                                        </Stack>
                                    </CardContent>
                                </FullHeightCard>
                            </Grid>
                        ))}
                    </Grid>

                    <WhySummary>
                        The honest summary: if your whole job is one idempotent write, you
                        don&apos;t need Outpost. The moment it becomes &ldquo;charge, then wait,
                        then fulfill, then notify,&rdquo; and any of those can fail independently,
                        you either build this yourself or you let Outpost handle it.
                    </WhySummary>
                </Container>
            </PaperSection>

            {/* How it works */}
            <PaperSection id="how">
                <Container maxWidth="lg">
                    <HeadStack spacing={1.5} alignItems="center">
                        <SectionIcon icon={<HubOutlinedIcon />} />
                        <Typography variant="h3">Durable steps in a few lines</Typography>
                        <NarrowCenteredMuted>
                            Annotate a class with <code>@Workflow</code>, mark durable methods with{" "}
                            <code>@Step</code>, and re-run the same identifier to resume. Completed
                            steps are memoized, so only uncommitted work runs again.
                        </NarrowCenteredMuted>
                    </HeadStack>
                    <CodeFrame>{quickStartBlock}</CodeFrame>
                </Container>
            </PaperSection>

            {/* Guarantees */}
            <Section maxWidth="lg">
                <HeadStack spacing={1.5} alignItems="center">
                    <SectionIcon icon={<VerifiedOutlinedIcon />} />
                    <Typography variant="h3">Correctness-first, by design</Typography>
                    <NarrowCenteredMuted>
                        Leasing, fencing, the commit window, and ambiguous-state resolution are the
                        parts we refuse to cut corners on.
                    </NarrowCenteredMuted>
                </HeadStack>
                <Grid container spacing={3}>
                    {guarantees.map((g) => (
                        <Grid key={g.title} size={{ xs: 12, sm: 6, md: 4 }}>
                            <FullHeightCard>
                                <CardContent>
                                    <GuaranteeIcon>{g.icon}</GuaranteeIcon>
                                    <CardTitle variant="h6">{g.title}</CardTitle>
                                    <MutedBodyLast variant="body2">{g.body}</MutedBodyLast>
                                </CardContent>
                            </FullHeightCard>
                        </Grid>
                    ))}
                </Grid>
            </Section>

            {/* Packages */}
            <PaperSection id="packages">
                <Container maxWidth="lg">
                    <HeadStack spacing={1.5} alignItems="center">
                        <SectionIcon icon={<ExtensionOutlinedIcon />} />
                        <Typography variant="h3">A small core, modular edges</Typography>
                        <NarrowCenteredMuted>
                            Transport, resilience, and alerting stay out of the core so it never
                            recreates the complexity it exists to avoid.
                        </NarrowCenteredMuted>
                    </HeadStack>
                    <Grid container spacing={2}>
                        {packages.map((pkg) => (
                            <Grid key={pkg.name} size={{ xs: 12, md: 6 }}>
                                <FullHeightCard>
                                    <CardContent>
                                        <Stack
                                            direction="row"
                                            spacing={1.5}
                                            alignItems="flex-start"
                                        >
                                            <PackageIcon>{pkg.icon}</PackageIcon>
                                            <Box>
                                                <PackageName>{pkg.name}</PackageName>
                                                <MutedBodyLast variant="body2">
                                                    {pkg.desc}
                                                </MutedBodyLast>
                                            </Box>
                                        </Stack>
                                    </CardContent>
                                </FullHeightCard>
                            </Grid>
                        ))}
                    </Grid>
                </Container>
            </PaperSection>

            {/* Limits */}
            <Section id="limits" maxWidth="lg">
                <Grid container spacing={6}>
                    <Grid size={{ xs: 12, md: 5 }}>
                        <SectionIcon icon={<ReportProblemOutlinedIcon />} align="left" />
                        <LimitsHeading variant="h3">Honest about the limits</LimitsHeading>
                        <MutedBodyLast>
                            Outpost is not a replacement for a dedicated orchestrator. If you need
                            deterministic replay across many languages and services today, reach for
                            one of those. Here is exactly what we don&apos;t promise.
                        </MutedBodyLast>
                    </Grid>
                    <Grid size={{ xs: 12, md: 7 }}>
                        <Stack spacing={2}>
                            {limits.map((limit, i) => (
                                <Box key={i}>
                                    <Stack direction="row" spacing={1.5}>
                                        <LimitIcon />
                                        <MutedBodyLast>{limit}</MutedBodyLast>
                                    </Stack>
                                    {i < limits.length - 1 && <LimitDivider />}
                                </Box>
                            ))}
                        </Stack>
                    </Grid>
                </Grid>
            </Section>

            {/* CTA */}
            <CtaSection>
                <CtaContainer maxWidth="md">
                    <CtaHeadline variant="h2">Durable steps without the cluster.</CtaHeadline>
                    <CtaLede>
                        Add Outpost to your existing app and close the ambiguous-failure window
                        today.
                    </CtaLede>
                    <Button
                        variant="contained"
                        size="large"
                        href="https://github.com"
                        target="_blank"
                        rel="noopener"
                        startIcon={<GitHubIcon />}
                    >
                        Get started on GitHub
                    </Button>
                </CtaContainer>
            </CtaSection>

            {/* Footer */}
            <Footer>
                <Container maxWidth="lg">
                    <Stack
                        direction={{ xs: "column", sm: "row" }}
                        justifyContent="space-between"
                        alignItems="center"
                        spacing={2}
                    >
                        <MutedBodyLast variant="body2">
                            © {new Date().getFullYear()} Outpost. Embeddable durable execution.
                        </MutedBodyLast>
                        <MutedBodyLast variant="body2">
                            Ships for Node and MySQL. Growing language and storage agnostic.
                        </MutedBodyLast>
                    </Stack>
                </Container>
            </Footer>
        </Box>
    );
}
