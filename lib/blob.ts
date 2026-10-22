import { issueSignedToken, presignUrl } from '@vercel/blob';

const DOWNLOAD_MINUTES = 10;

// A presigned GET for one private clip: agents and models fetch the video without any of this app's credentials.
export async function signDownload(pathname: string) {
  const validUntil = Date.now() + DOWNLOAD_MINUTES * 60_000;
  const token = await issueSignedToken({ pathname, operations: ['get'], validUntil });
  const { presignedUrl } = await presignUrl(token, { operation: 'get', pathname, access: 'private', validUntil });
  return { url: presignedUrl, expiresAt: new Date(validUntil) };
}
