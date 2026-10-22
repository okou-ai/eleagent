import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

let client: NeonQueryFunction<false, false> | null = null;

// Postgres from the Vercel Marketplace (Neon): the integration sets DATABASE_URL for every environment.
export function sql(): NeonQueryFunction<false, false> {
  if (!client) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error('DATABASE_URL is not set: connect a Neon database to this project');
    client = neon(url);
  }
  return client;
}
