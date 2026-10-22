import { createServer } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';

// An in-process Postgres (PGlite) behind the wire protocol, so tests use the same node-postgres Pool as production.
export async function startPostgres() {
  const db = await PGlite.create();
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1' });
  await server.start();
  // PGlite is a single session: one pooled connection keeps transactions from interleaving.
  const pool = new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:${port}/postgres`, max: 1 });
  return {
    pool,
    async stop() { await pool.end(); await server.stop(); await db.close(); },
  };
}
