import { configureLocalStorage } from "./storage";

/** The SQLite busy_timeout must come from the connection URL: Prisma applies
 *  `socket_timeout` to every pooled connection, while a PRAGMA through
 *  $queryRawUnsafe reaches exactly one of them. */
describe("local storage configuration", () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousDataDir = process.env.POS_DATA_DIR;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    process.env.POS_DATA_DIR = "/tmp/darpos-storage-spec";
  });

  afterAll(() => {
    if (previousUrl) process.env.DATABASE_URL = previousUrl;
    else delete process.env.DATABASE_URL;
    if (previousDataDir) process.env.POS_DATA_DIR = previousDataDir;
    else delete process.env.POS_DATA_DIR;
  });

  it("builds the SQLite URL with a socket_timeout so every pooled connection waits instead of failing with SQLITE_BUSY", () => {
    configureLocalStorage();
    expect(process.env.DATABASE_URL).toMatch(/^file:\/tmp\/darpos-storage-spec\/pos\.db\?socket_timeout=\d+$/);
  });

  it("never overrides an explicitly provided DATABASE_URL", () => {
    process.env.DATABASE_URL = "file:./custom.db";
    configureLocalStorage();
    expect(process.env.DATABASE_URL).toBe("file:./custom.db");
  });
});
