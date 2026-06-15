import { QuickSQLiteConnection } from 'react-native-quick-sqlite';
import { v1Up } from './v1';

interface Migration {
  version: number;
  up: string;
}

// Add new migrations here in ascending version order. Never modify existing entries.
const MIGRATIONS: Migration[] = [{ version: 1, up: v1Up }];

export async function runMigrations(db: QuickSQLiteConnection): Promise<void> {
  // schema_version may not exist on first launch — bootstrap it if absent.
  db.execute(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const result = db.execute(
    'SELECT COALESCE(MAX(version), 0) AS current FROM schema_version;',
  );
  const current: number = result.rows?.item(0)?.current ?? 0;

  const pending = MIGRATIONS.filter((m) => m.version > current);
  if (pending.length === 0) return;

  for (const migration of pending) {
    // Each migration runs inside a transaction. If any statement fails the
    // whole migration rolls back and the version row is never written, so the
    // next launch retries cleanly rather than leaving a half-applied schema.
    db.execute('BEGIN;');
    try {
      // SQLite doesn't support multiple statements in one execute() call with
      // all drivers, so we split on semicolons and run each statement.
      const statements = migration.up
        .split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      for (const stmt of statements) {
        db.execute(stmt + ';');
      }

      db.execute(
        'INSERT OR REPLACE INTO schema_version(version, applied_at) VALUES(?, ?);',
        [migration.version, Date.now()],
      );

      db.execute('COMMIT;');
    } catch (err) {
      db.execute('ROLLBACK;');
      throw new Error(`Migration v${migration.version} failed: ${String(err)}`);
    }
  }
}
