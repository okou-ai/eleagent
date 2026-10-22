import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The static ffmpeg binary that decodes clip frames for MCP: loaded from node_modules at run time, and shipped with
  // the /mcp function.
  serverExternalPackages: ['@ffmpeg-installer/ffmpeg'],
  outputFileTracingIncludes: {
    '/mcp': ['./node_modules/@ffmpeg-installer/linux-x64/**'],
    '/api/sleep/tools': ['./node_modules/@ffmpeg-installer/linux-x64/**'],
    '/api/clips/commit': ['./node_modules/@ffmpeg-installer/linux-x64/**'],
    // The files the sleeping agent runs with, copied into its sandbox.
    '/api/sleep': ['./sandbox/sleep/**'],
  },
};

export default nextConfig;
