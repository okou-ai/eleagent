import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The static ffmpeg binary that decodes clip frames for MCP: loaded from node_modules at run time, and shipped with
  // the /mcp function.
  serverExternalPackages: ['@ffmpeg-installer/ffmpeg'],
  outputFileTracingIncludes: { '/mcp': ['./node_modules/@ffmpeg-installer/linux-x64/**'] },
};

export default nextConfig;
