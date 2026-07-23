import type { NextConfig } from "next";

// STATIC_EXPORT=1 builds a fully static site for GitHub Pages: data comes
// from a pre-scraped /data/snapshot.json instead of the live API route.
// BASE_PATH is "/<repo-name>" on project pages (username.github.io/repo).
const isStatic = process.env.STATIC_EXPORT === "1";
const basePath = process.env.BASE_PATH ?? "";

const nextConfig: NextConfig = {
  ...(isStatic
    ? {
        output: "export",
        basePath,
        images: { unoptimized: true },
      }
    : {}),
  env: {
    NEXT_PUBLIC_STATIC_EXPORT: isStatic ? "1" : "",
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default nextConfig;
