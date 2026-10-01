import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse (pdf.js) ja selle DOMMatrix'i polüfill (@napi-rs/canvas) laetakse Node'is otse
  // node_modules'ist, mitte ei bundle'ita – muidu Vercelis "DOMMatrix is not defined".
  serverExternalPackages: ["pdf-parse", "@napi-rs/canvas"],
};

export default nextConfig;
