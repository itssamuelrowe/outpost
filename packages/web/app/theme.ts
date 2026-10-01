"use client";

import { createTheme } from "@mui/material/styles";

const theme = createTheme({
    palette: {
        mode: "dark",
        primary: {
            main: "#7c8bff",
        },
        secondary: {
            main: "#4ade80",
        },
        background: {
            default: "#0a0c14",
            paper: "#11141f",
        },
        text: {
            primary: "#e6e8f0",
            secondary: "#9aa0b4",
        },
    },
    shape: {
        borderRadius: 12,
    },
    typography: {
        fontFamily: "var(--font-roboto), system-ui, -apple-system, sans-serif",
        h1: { fontWeight: 800, letterSpacing: "-0.03em" },
        h2: { fontWeight: 800, letterSpacing: "-0.02em" },
        h3: { fontWeight: 700, letterSpacing: "-0.02em" },
        h4: { fontWeight: 700 },
        button: { textTransform: "none", fontWeight: 600 },
    },
    components: {
        MuiButton: {
            styleOverrides: {
                root: { borderRadius: 999, paddingInline: 22, paddingBlock: 10 },
            },
        },
        MuiCard: {
            styleOverrides: {
                root: {
                    backgroundImage: "none",
                    border: "1px solid rgba(255,255,255,0.08)",
                },
            },
        },
    },
});

export default theme;
