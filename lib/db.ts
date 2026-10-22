import { attachDatabasePool } from '@vercel/functions';
import pg from 'pg';

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let shared: pg.Pool | null = null;

// Postgres from the Vercel Marketplace (Neon): the integration sets DATABASE_URL for every environment. One pool per
// function instance, shared with Better Auth.
export function pool(): pg.Pool {
  if (!shared) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error('DATABASE_URL is not set: connect a Neon database to this project');
    shared = new pg.Pool({ connectionString: url, max: 5 });
    // Lets Vercel close idle connections before a function instance is suspended.
    attachDatabasePool(shared);
  }
  return shared;
}

// sql()`... ${value} ...` runs a query with each value as a parameter (never as SQL text) and returns its rows;
// sql().query(text, params) does the same for a query written with $1, $2, ...
export function sql() {
  const query = async (text: string, params: unknown[]) => (await pool().query(text, params)).rows as Row[];
  const tagged = (strings: TemplateStringsArray, ...values: unknown[]) =>
    query(strings.reduce((text, part, index) => `${text}$${index}${part}`), values);
  return Object.assign(tagged, { query });
}
