import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";
import { themes as prismThemes } from "prism-react-renderer";

/**
 * Docusaurus configuration for the Outpost documentation site.
 *
 * The site is docs-only: the landing page redirects into the documentation, so
 * readers arrive directly at the getting-started material.
 */
const config: Config = {
    title: "Outpost",
    tagline: "Durable execution you can embed in your app",
    favicon: "img/favicon.ico",
    url: "https://itssamuelrowe.github.io",
    baseUrl: "/outpost/",
    organizationName: "itssamuelrowe",
    projectName: "outpost",
    trailingSlash: false,
    onBrokenLinks: "warn",
    markdown: {
        hooks: {
            onBrokenMarkdownLinks: "warn",
        },
    },
    i18n: {
        defaultLocale: "en",
        locales: ["en"],
    },
    presets: [
        [
            "classic",
            {
                docs: {
                    routeBasePath: "/",
                    sidebarPath: "./sidebars.ts",
                },
                blog: false,
                theme: {
                    customCss: "./src/css/custom.css",
                },
            } satisfies Preset.Options,
        ],
    ],
    themeConfig: {
        navbar: {
            title: "Outpost",
            items: [{ type: "docSidebar", sidebarId: "docs", position: "left", label: "Docs" }],
        },
        footer: {
            style: "dark",
            copyright: "Outpost documentation.",
        },
        prism: {
            theme: prismThemes.github,
            darkTheme: prismThemes.dracula,
        },
    } satisfies Preset.ThemeConfig,
};

export default config;
