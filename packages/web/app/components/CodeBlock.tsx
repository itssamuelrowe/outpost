import { codeToHtml } from "shiki";

import { Chrome, CodeSurface, Filename, Frame, TrafficLight, TrafficLights } from "./CodeBlock.styles";

interface CodeBlockProps {
    code: string;
    filename?: string;
    lang?: string;
}

const TRAFFIC_LIGHT_COLORS = ["#ff5f57", "#febc2e", "#28c840"];

/**
 * An async Server Component code block with real syntax highlighting via Shiki.
 * Highlighting runs on the server at render time, so no client-side JS is
 * shipped for it. The window chrome header carries the "code" affordance.
 */
export default async function CodeBlock({ code, filename, lang = "ts" }: CodeBlockProps) {
    const html = await codeToHtml(code, {
        lang,
        theme: "github-dark-default",
    });

    return (
        <Frame>
            <Chrome>
                <TrafficLights>
                    {TRAFFIC_LIGHT_COLORS.map((color) => (
                        <TrafficLight key={color} dotColor={color} />
                    ))}
                </TrafficLights>
                {filename && <Filename>{filename}</Filename>}
            </Chrome>
            <CodeSurface dangerouslySetInnerHTML={{ __html: html }} />
        </Frame>
    );
}
