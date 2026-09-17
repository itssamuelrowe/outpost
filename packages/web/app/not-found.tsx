import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Container from "@mui/material/Container";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";

export default function NotFound() {
    return (
        <Container maxWidth="sm" sx={{ py: 20 }}>
            <Stack spacing={3} alignItems="center" textAlign="center">
                <Typography variant="h2" sx={{ fontSize: 72, color: "primary.main" }}>
                    404
                </Typography>
                <Typography variant="h5">This page drifted off the workflow.</Typography>
                <Box>
                    <Button variant="contained" href="/">
                        Back to home
                    </Button>
                </Box>
            </Stack>
        </Container>
    );
}
