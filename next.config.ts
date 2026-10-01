import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse (pdf.js) laetakse Node'is otse node_modules'ist, mitte ei bundle'ita
  serverExternalPackages: ["pdf-parse"],
};

export default nextConfig;
