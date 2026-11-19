import { createDb } from './database.js';
import { migrate } from './migrate.js';
import { seed } from './seed.js';

// scripts/support.sh 用：npm run db migrate、node dist/src/db/cli.js seed
const command = process.argv[2];
if (command === 'migrate') {
  const ran = await migrate(process.env);
  console.log(
    ran.length ? `migrated: ${ran.join(', ')}` : 'migrations up to date',
  );
} else if (command === 'seed') {
  const db = createDb(process.env);
  await seed(db, process.env);
  await db.end();
  console.log('seeded demo accounts');
} else {
  console.error('用法：cli.ts migrate|seed');
  process.exit(1);
}
