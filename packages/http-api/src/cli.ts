import { resolve } from 'node:path';
import { createJobApi, type Architecture } from './index.js';

async function main(): Promise<void> {
  const architecture = process.env.ARCHITECTURE ?? 'hexagonal';
  if (!['layered', 'hexagonal', 'cqrs'].includes(architecture)) throw new Error('Invalid ARCHITECTURE.');
  const port = Number(process.env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT.');
  const databasePath = process.env.DB_PATH ?? resolve('data', `${architecture}.sqlite`);
  const app = await createJobApi({ architecture: architecture as Architecture, databasePath });
  try {
    const address = await app.listen({ host: '127.0.0.1', port });
    process.stdout.write(`${JSON.stringify({ address, architecture })}\n`);
  } catch (error) { await app.close(); throw error; }
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await app.close();
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
}

main().catch(() => {
  process.stderr.write('Job API could not start. Check architecture, port, and database configuration.\n');
  process.exitCode = 1;
});
