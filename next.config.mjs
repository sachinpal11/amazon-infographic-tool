/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ['sharp'],
  experimental: {
    // allow larger photo uploads through route handlers
    serverActions: { bodySizeLimit: '25mb' },
  },
};

export default nextConfig;
