import Box from "@mui/material/Box";
import { codeToHtml } from "shiki";

/**
 * An async Server Component code block with real syntax highlighting via Shiki.
 * Highlighting runs on the server at render time, so no client-side JS is
 * shipped for it. The window chrome header carries the "code" affordance.
 */
export default async function CodeBlock({
    code,
    filename,
    lang = "ts",
}: {
    code: string;
    filename?: string;
    lang?: string;
}) {
    const html = await codeToHtml(code, {
        lang,
        theme: "github-dark-default",
    });

    return (
        <Box
            sx={{
                borderRadius: 3,
                overflow: "hidden",
                border: "1px solid rgba(255,255,255,0.1)",
                bgcolor: "#0d1018",
                boxShadow: "0 30px 80px -40px rgba(0,0,0,0.9)",
            }}
        >
            <Box
                sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 1,
                    px: 2,
                    py: 1.25,
                    borderBottom: "1px solid rgba(255,255,255,0.08)",
                    bgcolor: "rgba(255,255,255,0.02)",
                }}
            >
                <Box sx={{ display: "flex", gap: 0.75 }}>
                    {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
                        <Box
                            key={c}
                            sx={{ width: 11, height: 11, borderRadius: "50%", bgcolor: c }}
                        />
                    ))}
                </Box>
                {filename && (
                    <Box
                        component="span"
                        sx={{
                            ml: 1,
                            fontSize: 12.5,
                            color: "text.secondary",
                            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                        }}
                    >
                        {filename}
                    </Box>
                )}
            </Box>
            <Box
                sx={{
                    "& pre": {
                        m: 0,
                        p: 2.5,
                        overflowX: "auto",
                        fontSize: 13.5,
                        lineHeight: 1.7,
                        // Shiki sets its own background; override to match the block.
                        background: "#0d1018 !important",
                    },
                    "& code": {
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    },
                }}
                dangerouslySetInnerHTML={{ __html: html }}
            />
        </Box>
    );
}
