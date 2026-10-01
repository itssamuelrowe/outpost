"use client";

import Box from "@mui/material/Box";
import { styled } from "@mui/material/styles";

interface TrafficLightProps {
    dotColor: string;
}

const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, monospace";

export const Frame = styled(Box)({
    borderRadius: 24,
    overflow: "hidden",
    border: "1px solid rgba(255,255,255,0.1)",
    backgroundColor: "#0d1018",
    boxShadow: "0 30px 80px -40px rgba(0,0,0,0.9)",
});

export const Chrome = styled(Box)(({ theme }) => ({
    display: "flex",
    alignItems: "center",
    gap: theme.spacing(1),
    padding: theme.spacing(1.25, 2),
    borderBottom: "1px solid rgba(255,255,255,0.08)",
    backgroundColor: "rgba(255,255,255,0.02)",
}));

export const TrafficLights = styled(Box)(({ theme }) => ({
    display: "flex",
    gap: theme.spacing(0.75),
}));

export const TrafficLight = styled(Box, {
    shouldForwardProp: (prop) => prop !== "dotColor",
})<TrafficLightProps>(({ dotColor }) => ({
    width: 11,
    height: 11,
    borderRadius: "50%",
    backgroundColor: dotColor,
}));

export const Filename = styled("span")(({ theme }) => ({
    marginLeft: theme.spacing(1),
    fontSize: 12.5,
    color: theme.palette.text.secondary,
    fontFamily: MONO_FONT,
}));

export const CodeSurface = styled(Box)({
    "& pre": {
        margin: 0,
        padding: 20,
        overflowX: "auto",
        fontSize: 13.5,
        lineHeight: 1.7,
        /* Shiki sets its own background; override to match the block. */
        background: "#0d1018 !important",
    },
    "& code": {
        fontFamily: MONO_FONT,
    },
});
