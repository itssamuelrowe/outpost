"use client";

import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import HubOutlinedIcon from "@mui/icons-material/HubOutlined";

const links = [
    { label: "Problem", href: "#problem" },
    { label: "Why Outpost", href: "#why" },
    { label: "How it works", href: "#how" },
    { label: "Packages", href: "#packages" },
    { label: "Limits", href: "#limits" },
];

export default function NavBar() {
    return (
        <AppBar
            position="sticky"
            elevation={0}
            sx={{
                bgcolor: "rgba(10,12,20,0.72)",
                backdropFilter: "blur(12px)",
                borderBottom: "1px solid rgba(255,255,255,0.06)",
            }}
        >
            <Container maxWidth="lg">
                <Toolbar disableGutters sx={{ gap: 2 }}>
                    <Stack direction="row" alignItems="center" spacing={1.25} sx={{ flexGrow: 1 }}>
                        <HubOutlinedIcon sx={{ color: "primary.main" }} />
                        <Typography variant="h6" fontWeight={800} letterSpacing="-0.02em">
                            Outpost
                        </Typography>
                    </Stack>

                    <Stack direction="row" spacing={1} sx={{ display: { xs: "none", md: "flex" } }}>
                        {links.map((link) => (
                            <Button
                                key={link.href}
                                href={link.href}
                                color="inherit"
                                sx={{ color: "text.secondary" }}
                            >
                                {link.label}
                            </Button>
                        ))}
                    </Stack>

                    <Box sx={{ ml: { xs: 0, md: 2 } }}>
                        <Button
                            variant="contained"
                            href="https://github.com"
                            target="_blank"
                            rel="noopener"
                        >
                            GitHub
                        </Button>
                    </Box>
                </Toolbar>
            </Container>
        </AppBar>
    );
}
