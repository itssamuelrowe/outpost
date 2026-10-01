"use client";

import Box from "@mui/material/Box";
import Button, { type ButtonProps } from "@mui/material/Button";
import Card from "@mui/material/Card";
import Chip from "@mui/material/Chip";
import Container from "@mui/material/Container";
import Divider from "@mui/material/Divider";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { styled } from "@mui/material/styles";
import WarningAmberOutlinedIcon from "@mui/icons-material/WarningAmberOutlined";

const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

export const SectionIconFrame = styled(Box, {
    shouldForwardProp: (prop) => prop !== "align",
})<{ align: "center" | "left" }>(({ align }) => ({
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: 52,
    height: 52,
    borderRadius: 12,
    color: "#7c8bff",
    backgroundColor: "rgba(124,139,255,0.12)",
    border: "1px solid rgba(124,139,255,0.25)",
    marginLeft: align === "center" ? "auto" : 0,
    marginRight: align === "center" ? "auto" : 0,
}));

export const HeroSection = styled(Box)({
    position: "relative",
    overflow: "hidden",
    background:
        "radial-gradient(1200px 600px at 50% -10%, rgba(124,139,255,0.18), transparent 60%)",
});

export const HeroContainer = styled(Container)(({ theme }) => ({
    paddingTop: theme.spacing(8),
    paddingBottom: theme.spacing(8),
    [theme.breakpoints.up("md")]: {
        paddingTop: theme.spacing(14),
        paddingBottom: theme.spacing(12),
    },
}));

export const HeroChip = styled(Chip)(({ theme }) => ({
    borderColor: "rgba(255,255,255,0.15)",
    color: theme.palette.text.secondary,
}));

export const HeroHeadline = styled(Typography)(({ theme }) => ({
    fontSize: 40,
    maxWidth: 900,
    [theme.breakpoints.up("md")]: {
        fontSize: 68,
    },
}));

export const HeroLede = styled(Typography)(({ theme }) => ({
    color: theme.palette.text.secondary,
    maxWidth: 720,
    fontWeight: 400,
}));

export const DocsButton = styled(Button)<ButtonProps<"a">>(({ theme }) => ({
    borderColor: "rgba(255,255,255,0.2)",
    color: theme.palette.text.primary,
}));

export const HighlightRow = styled(Stack)(({ theme }) => ({
    paddingTop: theme.spacing(1),
}));

export const HighlightItem = styled(Stack)(({ theme }) => ({
    color: theme.palette.text.secondary,
}));

export const HighlightIcon = styled(Box)(({ theme }) => ({
    color: theme.palette.secondary.main,
    display: "flex",
}));

export const MutedCaption = styled(Typography)(({ theme }) => ({
    color: theme.palette.text.secondary,
}));

export const Section = styled(Container)(({ theme }) => ({
    paddingTop: theme.spacing(8),
    paddingBottom: theme.spacing(8),
    [theme.breakpoints.up("md")]: {
        paddingTop: theme.spacing(12),
        paddingBottom: theme.spacing(12),
    },
}));

export const PaperSection = styled(Box)(({ theme }) => ({
    backgroundColor: theme.palette.background.paper,
    paddingTop: theme.spacing(8),
    paddingBottom: theme.spacing(8),
    [theme.breakpoints.up("md")]: {
        paddingTop: theme.spacing(12),
        paddingBottom: theme.spacing(12),
    },
}));

export const ProblemChip = styled(Chip)({
    marginBottom: 16,
    backgroundColor: "rgba(254,188,46,0.12)",
    color: "#febc2e",
});

export const SectionHeading = styled(Typography)(({ theme }) => ({
    marginBottom: theme.spacing(2),
}));

export const MutedBody = styled(Typography)(({ theme }) => ({
    color: theme.palette.text.secondary,
    marginBottom: theme.spacing(2),
}));

export const MutedBodyLast = styled(Typography)(({ theme }) => ({
    color: theme.palette.text.secondary,
}));

export const InlineCode = styled("code")(({ theme }) => ({
    color: theme.palette.secondary.main,
}));

export const HeadStack = styled(Stack)(({ theme }) => ({
    marginBottom: theme.spacing(6),
    textAlign: "center",
}));

export const CenteredMuted = styled(Typography)(({ theme }) => ({
    color: theme.palette.text.secondary,
    maxWidth: 720,
    marginLeft: "auto",
    marginRight: "auto",
}));

export const NarrowCenteredMuted = styled(Typography)(({ theme }) => ({
    color: theme.palette.text.secondary,
    maxWidth: 640,
    marginLeft: "auto",
    marginRight: "auto",
}));

export const FullHeightCard = styled(Card)({
    height: "100%",
});

export const WhyBadge = styled(Box)({
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 44,
    height: 44,
    borderRadius: 8,
    flexShrink: 0,
    color: "#4ade80",
    backgroundColor: "rgba(74,222,128,0.12)",
});

export const WhyTitle = styled(Typography)(({ theme }) => ({
    marginBottom: theme.spacing(0.75),
    fontSize: 18,
}));

export const WhySummary = styled(Typography)(({ theme }) => ({
    color: theme.palette.text.secondary,
    maxWidth: 760,
    marginLeft: "auto",
    marginRight: "auto",
    marginTop: theme.spacing(5),
    textAlign: "center",
}));

export const CodeFrame = styled(Box)({
    maxWidth: 860,
    marginLeft: "auto",
    marginRight: "auto",
});

export const GuaranteeIcon = styled(Box)(({ theme }) => ({
    color: theme.palette.primary.main,
    marginBottom: theme.spacing(1.5),
}));

export const CardTitle = styled(Typography)(({ theme }) => ({
    marginBottom: theme.spacing(1),
}));

export const PackageIcon = styled(Box)({
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 40,
    height: 40,
    borderRadius: 8,
    flexShrink: 0,
    color: "#7c8bff",
    backgroundColor: "rgba(124,139,255,0.12)",
});

export const PackageName = styled(Typography)(({ theme }) => ({
    fontFamily: MONO_FONT,
    color: theme.palette.primary.main,
    marginBottom: theme.spacing(0.5),
}));

export const LimitsHeading = styled(Typography)(({ theme }) => ({
    marginBottom: theme.spacing(2),
    marginTop: theme.spacing(2),
}));

export const LimitIcon = styled(WarningAmberOutlinedIcon)(({ theme }) => ({
    color: "#febc2e",
    marginTop: theme.spacing(0.25),
}));

export const LimitDivider = styled(Divider)(({ theme }) => ({
    marginTop: theme.spacing(2),
    borderColor: "rgba(255,255,255,0.06)",
}));

export const CtaSection = styled(Box)({
    background:
        "radial-gradient(900px 400px at 50% 120%, rgba(124,139,255,0.2), transparent 60%)",
    borderTop: "1px solid rgba(255,255,255,0.06)",
});

export const CtaContainer = styled(Container)(({ theme }) => ({
    paddingTop: theme.spacing(10),
    paddingBottom: theme.spacing(10),
    textAlign: "center",
    [theme.breakpoints.up("md")]: {
        paddingTop: theme.spacing(14),
        paddingBottom: theme.spacing(14),
    },
}));

export const CtaHeadline = styled(Typography)(({ theme }) => ({
    fontSize: 32,
    marginBottom: theme.spacing(2),
    [theme.breakpoints.up("md")]: {
        fontSize: 48,
    },
}));

export const CtaLede = styled(Typography)(({ theme }) => ({
    color: theme.palette.text.secondary,
    marginBottom: theme.spacing(4),
    maxWidth: 560,
    marginLeft: "auto",
    marginRight: "auto",
}));

export const Footer = styled(Box)(({ theme }) => ({
    borderTop: "1px solid rgba(255,255,255,0.06)",
    paddingTop: theme.spacing(4),
    paddingBottom: theme.spacing(4),
}));
