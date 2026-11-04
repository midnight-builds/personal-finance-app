// Must be the FIRST import of every test file (enforced by tests/test-isolation.test.ts).
// ESM evaluates imports before the importing module's own code, so assigning
// DB_PATH in the test body comes too late: src/db.ts would already have opened
// the default file database. Side-effect imports run in order, so this one wins.
process.env.DB_PATH = ':memory:';

export {};
