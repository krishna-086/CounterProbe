import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  // Hide the dev-mode floating "N" indicator in the corner.
  devIndicators: false,
};

export default nextConfig;
