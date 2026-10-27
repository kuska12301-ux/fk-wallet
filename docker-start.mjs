import { mkdirSync, chownSync, lstatSync, existsSync, copyFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';

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
  // The previous single-instance server has stopped before this container starts.
  // Save all SQLite files before the first Crypto Pay schema migration.
  const backup=join(directory,'pre-crypto-backup'),marker=join(backup,'.complete');
  if(existsSync(database)&&!existsSync(marker)) {
    mkdirSync(backup,{recursive:true,mode:0o700});
    if(lstatSync(backup).isSymbolicLink())throw new Error('Backup directory must not be a symbolic link');
    for(const path of [database,`${database}-wal`,`${database}-shm`])if(existsSync(path))copyFileSync(path,join(backup,basename(path)));
    writeFileSync(marker,new Date().toISOString(),{mode:0o600});
    console.log('SQLite: резервная копия перед Crypto Pay сохранена');
  }
  process.setgid(1000);
  process.setuid(1000);
}
await import('./server/index.mjs');
