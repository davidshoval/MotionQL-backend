import { MongoMemoryServer } from 'mongodb-memory-server';
import type { TestProject } from 'vitest/node';

let server: MongoMemoryServer | undefined;

/** One in-memory mongod for the run (each test file uses its own database). TEST_MONGODB_URI uses a real one instead. */
export async function setup(project: TestProject) {
  let uri = process.env.TEST_MONGODB_URI;
  if (!uri) {
    server = await MongoMemoryServer.create();
    uri = server.getUri();
  }
  project.provide('mongoUri', uri);
}

export async function teardown() {
  await server?.stop();
}

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
  }
}
