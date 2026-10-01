"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { styled } from "@mui/material/styles";

const Page = styled(Container)(({ theme }) => ({
    paddingTop: theme.spacing(20),
    paddingBottom: theme.spacing(20),
}));

const Code = styled(Typography)(({ theme }) => ({
    fontSize: 72,
    color: theme.palette.primary.main,
}));

export default function NotFound() {
    return (
        <Page maxWidth="sm">
            <Stack spacing={3} alignItems="center" textAlign="center">
                <Code variant="h2">404</Code>
                <Typography variant="h5">This page drifted off the workflow.</Typography>
                <Box>
                    <Button variant="contained" href="/">
                        Back to home
                    </Button>
                </Box>
            </Stack>
        </Page>
    );
}
