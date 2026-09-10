import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The repo root also has a yarn.lock (monorepo); pin tracing to this app so
  // Next stops inferring the workspace root from the wrong lockfile.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
