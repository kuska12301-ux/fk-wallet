import { mkdirSync, chownSync, lstatSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

// Hosting volumes can replace the image's data directory with a root-owned one.
// Prepare only the database directory and SQLite files, then drop privileges.
if (process.getuid?.() === 0) {
  const database = resolve(process.env.DB_PATH || './data/fk-wallet.sqlite');
  const directory = dirname(database);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const path of [directory, database, `${database}-wal`, `${database}-shm`]) {
    if (existsSync(path)) {
      if (lstatSync(path).isSymbolicLink()) throw new Error('Database paths must not be symbolic links');
      chownSync(path, 1000, 1000);
    }
  }
  process.setgid(1000);
  process.setuid(1000);
}
await import('./server/index.mjs');
