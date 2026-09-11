import type { NextConfig } from "next";
const config: NextConfig = {
  agentRules: false,
  distDir: process.env.NEXT_DIST_DIR || ".next",
  devIndicators: false,
  logging: false,
};
export default config;
