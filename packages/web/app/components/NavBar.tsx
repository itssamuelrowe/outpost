"use client";

import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { styled } from "@mui/material/styles";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";

interface NavLink {
    label: string;
    href: string;
}

const links: NavLink[] = [
    { label: "Problem", href: "#problem" },
    { label: "Why Outpost", href: "#why" },
    { label: "How it works", href: "#how" },
    { label: "Packages", href: "#packages" },
    { label: "Limits", href: "#limits" },
];

const Bar = styled(AppBar)({
    backgroundColor: "rgba(10,12,20,0.72)",
    backdropFilter: "blur(12px)",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
});

const NavToolbar = styled(Toolbar)(({ theme }) => ({
    gap: theme.spacing(2),
}));

const Brand = styled(Stack)({
    flexGrow: 1,
});

const BrandIcon = styled(HubOutlinedIcon)(({ theme }) => ({
    color: theme.palette.primary.main,
}));

const BrandName = styled(Typography)({
    fontWeight: 800,
    letterSpacing: "-0.02em",
});

const NavLinks = styled(Stack)(({ theme }) => ({
    display: "none",
    [theme.breakpoints.up("md")]: {
        display: "flex",
    },
}));

const NavLinkButton = styled(Button)(({ theme }) => ({
    color: theme.palette.text.secondary,
}));

const Actions = styled(Box)(({ theme }) => ({
    marginLeft: 0,
    [theme.breakpoints.up("md")]: {
        marginLeft: theme.spacing(2),
    },
}));

export default function NavBar() {
    return (
        <Bar position="sticky" elevation={0}>
            <Container maxWidth="lg">
                <NavToolbar disableGutters>
                    <Brand direction="row" alignItems="center" spacing={1.25}>
                        <BrandIcon />
                        <BrandName variant="h6">Outpost</BrandName>
                    </Brand>

                    <NavLinks direction="row" spacing={1}>
                        {links.map((link) => (
                            <NavLinkButton key={link.href} href={link.href} color="inherit">
                                {link.label}
                            </NavLinkButton>
                        ))}
                    </NavLinks>

                    <Actions>
                        <Button
                            variant="contained"
                            href="https://github.com"
                            target="_blank"
                            rel="noopener"
                        >
                            GitHub
                        </Button>
                    </Actions>
                </NavToolbar>
            </Container>
        </Bar>
    );
}
