import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {},
  // Amplify exposes these only at BUILD time. Inlining them here bakes the
  // values into the server bundle so the API routes (Lambda) can read them at
  // runtime — Amplify does not forward env vars to the Next.js SSR runtime.
  env: {
    GROQ_API_KEY: process.env.GROQ_API_KEY ?? "",
    APP_AWS_ACCESS_KEY_ID: process.env.APP_AWS_ACCESS_KEY_ID ?? "",
    APP_AWS_SECRET_ACCESS_KEY: process.env.APP_AWS_SECRET_ACCESS_KEY ?? "",
    APP_AWS_REGION: process.env.APP_AWS_REGION ?? "",
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
      };
    }
    return config;
  },
};

export default nextConfig;
