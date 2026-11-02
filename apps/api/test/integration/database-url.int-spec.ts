import { integrationDatabaseUrl } from "./database-url";

describe("integrationDatabaseUrl", () => {
  const base = "postgresql://user:secret@127.0.0.1:5432/pharmaceylon";
  const name = (url: string) => new URL(url).pathname.slice(1);

  it("gives each checkout its own database on the developer's server", () => {
    const one = integrationDatabaseUrl({ DATABASE_URL: base }, "/work/repo");
    const two = integrationDatabaseUrl({ DATABASE_URL: base }, "/work/repo/.claude/worktrees/other");
    expect(name(one)).toMatch(/^pharmaceylon_it_[0-9a-f]{8}$/);
    expect(name(two)).toMatch(/^pharmaceylon_it_[0-9a-f]{8}$/);
    expect(one).not.toBe(two);
    expect(new URL(one)).toMatchObject({ username: "user", password: "secret", host: "127.0.0.1:5432" });
  });

  it("is stable for the same checkout", () => {
    expect(integrationDatabaseUrl({ DATABASE_URL: base }, "/work/repo")).toBe(
      integrationDatabaseUrl({ DATABASE_URL: base }, "/work/repo"),
    );
  });

  it("keeps the name within PostgreSQL's 63-character identifier limit", () => {
    const long = `postgresql://u:p@localhost/${"x".repeat(80)}`;
    const result = name(integrationDatabaseUrl({ DATABASE_URL: long }, "/work/repo"));
    expect(result).toHaveLength(63);
    expect(result).toMatch(/_it_[0-9a-f]{8}$/);
  });

  it("uses INTEGRATION_DATABASE_URL as given", () => {
    const explicit = "postgresql://u:p@localhost/chosen";
    expect(integrationDatabaseUrl({ DATABASE_URL: base, INTEGRATION_DATABASE_URL: explicit })).toBe(explicit);
  });

  it("needs DATABASE_URL", () => {
    expect(() => integrationDatabaseUrl({})).toThrow("DATABASE_URL is required");
  });
});
