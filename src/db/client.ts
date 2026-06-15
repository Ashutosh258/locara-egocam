import { open, QuickSQLiteConnection } from 'react-native-quick-sqlite';
import { runMigrations } from './migrations/runner';

let connection: QuickSQLiteConnection | null = null;

export function getDb(): QuickSQLiteConnection {
  if (!connection) {
    throw new Error('DB not initialised — call initDb() first');
  }
  return connection;
}

export async function initDb(): Promise<void> {
  if (connection) return;

  connection = open({ name: 'egocam.db', location: 'default' });

  // WAL mode gives us concurrent reads + crash-safe writes without
  // the performance cost of full sync. Essential for the upload queue
  // reading while the camera module writes.
  connection.execute('PRAGMA journal_mode = WAL;');
  connection.execute('PRAGMA foreign_keys = ON;');

  await runMigrations(connection);
}

export function closeDb(): void {
  connection?.close();
  connection = null;
}
