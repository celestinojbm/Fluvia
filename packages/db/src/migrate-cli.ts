import { dbUrlsFromEnv } from './config.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

const pool = createPool({ connectionString: dbUrlsFromEnv().admin, max: 2 });

migrate(pool)
  .then((applied) => {
    if (applied.length === 0) {
      console.log('schema up to date, nothing applied');
    } else {
      for (const name of applied) console.log(`applied ${name}`);
    }
    return pool.end();
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
    return pool.end();
  });
