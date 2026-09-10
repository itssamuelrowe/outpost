import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Card from "@mui/material/Card";
import CardContent from "@mui/material/CardContent";
import Chip from "@mui/material/Chip";
import Container from "@mui/material/Container";
import Divider from "@mui/material/Divider";
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

import NavBar from "./components/NavBar";
import CodeBlock from "./components/CodeBlock";

/** A framed accent icon used to anchor section headings. */
function SectionIcon({
  icon,
  align = "center",
}: {
  icon: React.ReactNode;
  align?: "center" | "left";
}) {
  return (
    <Box
      sx={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 52,
        height: 52,
        borderRadius: 3,
        color: "primary.main",
        bgcolor: "rgba(124,139,255,0.12)",
        border: "1px solid rgba(124,139,255,0.25)",
        mx: align === "center" ? "auto" : 0,
      }}
    >
      {icon}
    </Box>
  );
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

const guarantees = [
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

const packages: Array<{ name: string; desc: string; icon: React.ReactNode }> = [
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

const heroHighlights = [
  { icon: <TravelExploreOutlinedIcon fontSize="small" />, label: "Probe-first recovery" },
  { icon: <VerifiedOutlinedIcon fontSize="small" />, label: "Idempotent by design" },
  { icon: <LayersOutlinedIcon fontSize="small" />, label: "Runs in your process" },
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
      <Box
        sx={{
          position: "relative",
          overflow: "hidden",
          background:
            "radial-gradient(1200px 600px at 50% -10%, rgba(124,139,255,0.18), transparent 60%)",
        }}
      >
        <Container maxWidth="lg" sx={{ pt: { xs: 8, md: 14 }, pb: { xs: 8, md: 12 } }}>
          <Stack spacing={4} alignItems="center" textAlign="center">
            <Chip
              label="Durable execution · embeddable · no cluster"
              variant="outlined"
              sx={{ borderColor: "rgba(255,255,255,0.15)", color: "text.secondary" }}
            />
            <Typography variant="h1" sx={{ fontSize: { xs: 40, md: 68 }, maxWidth: 900 }}>
              Stop doing it twice when the API says it failed.
            </Typography>
            <Typography
              variant="h6"
              sx={{ color: "text.secondary", maxWidth: 720, fontWeight: 400 }}
            >
              Outpost is an embeddable durable execution library that resolves the
              ambiguous-failure window, the moment when your call returns a 5xx but the
              write actually succeeded. It runs inside your app process and coordinates
              through your own database. No orchestrator, no daemon, no cluster.
            </Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <Button
                variant="contained"
                size="large"
                href="#how"
                endIcon={<ArrowForwardIcon />}
              >
                See how it works
              </Button>
              <Button
                variant="outlined"
                size="large"
                href="https://github.com"
                target="_blank"
                rel="noopener"
                startIcon={<MenuBookOutlinedIcon />}
                sx={{ borderColor: "rgba(255,255,255,0.2)", color: "text.primary" }}
              >
                Read the docs
              </Button>
            </Stack>

            <Stack
              direction={{ xs: "column", sm: "row" }}
              spacing={{ xs: 1, sm: 3 }}
              justifyContent="center"
              sx={{ pt: 1 }}
            >
              {heroHighlights.map((h) => (
                <Stack
                  key={h.label}
                  direction="row"
                  spacing={0.75}
                  alignItems="center"
                  sx={{ color: "text.secondary" }}
                >
                  <Box sx={{ color: "secondary.main", display: "flex" }}>{h.icon}</Box>
                  <Typography variant="body2">{h.label}</Typography>
                </Stack>
              ))}
            </Stack>

            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              Ships for Node and MySQL today. Built to grow language and storage agnostic.
            </Typography>
          </Stack>
        </Container>
      </Box>

      {/* Problem */}
      <Container id="problem" maxWidth="lg" sx={{ py: { xs: 8, md: 12 } }}>
        <Grid container spacing={6} alignItems="center">
          <Grid size={{ xs: 12, md: 5 }}>
            <Chip
              icon={<WarningAmberOutlinedIcon />}
              label="The ambiguous-failure window"
              sx={{ mb: 2, bgcolor: "rgba(254,188,46,0.12)", color: "#febc2e" }}
            />
            <Typography variant="h3" sx={{ mb: 2 }}>
              The 5xx that already succeeded
            </Typography>
            <Typography sx={{ color: "text.secondary", mb: 2 }}>
              You call a payment provider or Shopify. It returns a 504. Did the charge
              go through? Did the order get created? You genuinely don&apos;t know.
            </Typography>
            <Typography sx={{ color: "text.secondary" }}>
              Your queue redelivers. Your retry fires again. Now you&apos;ve charged the
              card twice. Idempotency keys alone don&apos;t close this window, because the
              failure happened between the side effect and your durable commit. Outpost
              treats this as a first-class case. It records the step as{" "}
              <Box component="code" sx={{ color: "secondary.main" }}>AMBIGUOUS</Box> and{" "}
              <strong>probes before it re-executes</strong>.
            </Typography>
          </Grid>
          <Grid size={{ xs: 12, md: 7 }}>{probeBlock}</Grid>
        </Grid>
      </Container>

      {/* How it works */}
      <Box id="how" sx={{ bgcolor: "background.paper", py: { xs: 8, md: 12 } }}>
        <Container maxWidth="lg">
          <Stack spacing={1.5} sx={{ mb: 6, textAlign: "center" }} alignItems="center">
            <SectionIcon icon={<HubOutlinedIcon />} />
            <Typography variant="h3">Durable steps in a few lines</Typography>
            <Typography sx={{ color: "text.secondary", maxWidth: 640, mx: "auto" }}>
              Annotate a class with <code>@Workflow</code>, mark durable methods with{" "}
              <code>@Step</code>, and re-run the same identifier to resume. Completed
              steps are memoized, so only uncommitted work runs again.
            </Typography>
          </Stack>
          <Box sx={{ maxWidth: 860, mx: "auto" }}>{quickStartBlock}</Box>
        </Container>
      </Box>

      {/* Guarantees */}
      <Container maxWidth="lg" sx={{ py: { xs: 8, md: 12 } }}>
        <Stack spacing={1.5} sx={{ mb: 6, textAlign: "center" }} alignItems="center">
          <SectionIcon icon={<VerifiedOutlinedIcon />} />
          <Typography variant="h3">Correctness-first, by design</Typography>
          <Typography sx={{ color: "text.secondary", maxWidth: 640, mx: "auto" }}>
            Leasing, fencing, the commit window, and ambiguous-state resolution are the
            parts we refuse to cut corners on.
          </Typography>
        </Stack>
        <Grid container spacing={3}>
          {guarantees.map((g) => (
            <Grid key={g.title} size={{ xs: 12, sm: 6, md: 4 }}>
              <Card sx={{ height: "100%" }}>
                <CardContent>
                  <Box sx={{ color: "primary.main", mb: 1.5 }}>{g.icon}</Box>
                  <Typography variant="h6" sx={{ mb: 1 }}>
                    {g.title}
                  </Typography>
                  <Typography sx={{ color: "text.secondary" }} variant="body2">
                    {g.body}
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
          ))}
        </Grid>
      </Container>

      {/* Packages */}
      <Box id="packages" sx={{ bgcolor: "background.paper", py: { xs: 8, md: 12 } }}>
        <Container maxWidth="lg">
          <Stack spacing={1.5} sx={{ mb: 6, textAlign: "center" }} alignItems="center">
            <SectionIcon icon={<ExtensionOutlinedIcon />} />
            <Typography variant="h3">A small core, modular edges</Typography>
            <Typography sx={{ color: "text.secondary", maxWidth: 640, mx: "auto" }}>
              Transport, resilience, and alerting stay out of the core so it never
              recreates the complexity it exists to avoid.
            </Typography>
          </Stack>
          <Grid container spacing={2}>
            {packages.map((pkg) => (
              <Grid key={pkg.name} size={{ xs: 12, md: 6 }}>
                <Card sx={{ height: "100%" }}>
                  <CardContent>
                    <Stack direction="row" spacing={1.5} alignItems="flex-start">
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 40,
                          height: 40,
                          borderRadius: 2,
                          flexShrink: 0,
                          color: "primary.main",
                          bgcolor: "rgba(124,139,255,0.12)",
                        }}
                      >
                        {pkg.icon}
                      </Box>
                      <Box>
                        <Typography
                          sx={{
                            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                            color: "primary.main",
                            mb: 0.5,
                          }}
                        >
                          {pkg.name}
                        </Typography>
                        <Typography variant="body2" sx={{ color: "text.secondary" }}>
                          {pkg.desc}
                        </Typography>
                      </Box>
                    </Stack>
                  </CardContent>
                </Card>
              </Grid>
            ))}
          </Grid>
        </Container>
      </Box>

      {/* Limits */}
      <Container id="limits" maxWidth="lg" sx={{ py: { xs: 8, md: 12 } }}>
        <Grid container spacing={6}>
          <Grid size={{ xs: 12, md: 5 }}>
            <SectionIcon icon={<ReportProblemOutlinedIcon />} align="left" />
            <Typography variant="h3" sx={{ mb: 2, mt: 2 }}>
              Honest about the limits
            </Typography>
            <Typography sx={{ color: "text.secondary" }}>
              Outpost is not a replacement for a dedicated orchestrator. If you need
              deterministic replay across many languages and services today, reach for
              one of those. Here is exactly what we don&apos;t promise.
            </Typography>
          </Grid>
          <Grid size={{ xs: 12, md: 7 }}>
            <Stack spacing={2}>
              {limits.map((limit, i) => (
                <Box key={i}>
                  <Stack direction="row" spacing={1.5}>
                    <WarningAmberOutlinedIcon sx={{ color: "#febc2e", mt: 0.25 }} />
                    <Typography sx={{ color: "text.secondary" }}>{limit}</Typography>
                  </Stack>
                  {i < limits.length - 1 && (
                    <Divider sx={{ mt: 2, borderColor: "rgba(255,255,255,0.06)" }} />
                  )}
                </Box>
              ))}
            </Stack>
          </Grid>
        </Grid>
      </Container>

      {/* CTA */}
      <Box
        sx={{
          background:
            "radial-gradient(900px 400px at 50% 120%, rgba(124,139,255,0.2), transparent 60%)",
          borderTop: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <Container maxWidth="md" sx={{ py: { xs: 10, md: 14 }, textAlign: "center" }}>
          <Typography variant="h2" sx={{ fontSize: { xs: 32, md: 48 }, mb: 2 }}>
            Durable steps without the cluster.
          </Typography>
          <Typography sx={{ color: "text.secondary", mb: 4, maxWidth: 560, mx: "auto" }}>
            Add Outpost to your existing app and close the ambiguous-failure window
            today.
          </Typography>
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
        </Container>
      </Box>

      {/* Footer */}
      <Box sx={{ borderTop: "1px solid rgba(255,255,255,0.06)", py: 4 }}>
        <Container maxWidth="lg">
          <Stack
            direction={{ xs: "column", sm: "row" }}
            justifyContent="space-between"
            alignItems="center"
            spacing={2}
          >
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              © {new Date().getFullYear()} Outpost. Embeddable durable execution.
            </Typography>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              Ships for Node and MySQL. Growing language and storage agnostic.
            </Typography>
          </Stack>
        </Container>
      </Box>
    </Box>
  );
}
