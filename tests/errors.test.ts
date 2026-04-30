// Error contract: every public SDK entry point throws a typed MneoError
// (NotFoundError, InvalidInputError, RepoBrokenError, ConflictError) so the
// MCP layer can surface a structured {code, message} payload to LLM consumers
// and so context() can route on the type for graceful degradation.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { context } from "../packages/mneo/src/context.ts";
import {
  InvalidInputError,
  MneoError,
  NotFoundError,
  RepoBrokenError,
  findRepo,
  forget,
  list,
  read,
  record,
} from "../packages/mneo/src/index.ts";
import { findProjectDir, installHook } from "../packages/mneo/src/init-hook.ts";

import { type TempRepo, makeTempRepo } from "./helpers/repo.ts";

describe("error contract — read", () => {
  let fixture: TempRepo;

  beforeEach(() => {
    fixture = makeTempRepo();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("missing slug throws NotFoundError with code NOT_FOUND", () => {
    try {
      read({ repo: fixture.repo, slug: "missing", scope: "main" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect(e).toBeInstanceOf(MneoError);
      expect(e).toBeInstanceOf(Error);
      expect((e as NotFoundError).code).toBe("NOT_FOUND");
      expect((e as Error).message).toMatch(/not found/);
    }
  });

  test("missing scope/slug throws NotFoundError, not raw git error", () => {
    record({ repo: fixture.repo, body: "hello", slug: "x", scope: "main" });
    try {
      read({ repo: fixture.repo, slug: "missing-slug", scope: "no-such-scope" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect((e as NotFoundError).code).toBe("NOT_FOUND");
      // Recovery prompt for the LLM — never leak raw git plumbing strings.
      expect((e as Error).message).not.toMatch(/^fatal:/);
      expect((e as Error).message).not.toMatch(/invalid object name/);
    }
  });

  test("happy path returns body without throwing", () => {
    record({ repo: fixture.repo, body: "hello", slug: "x", scope: "main" });
    const r = read({ repo: fixture.repo, slug: "x", scope: "main" });
    expect(r.body).toBe("hello");
  });
});

describe("error contract — record", () => {
  let fixture: TempRepo;
  beforeEach(() => {
    fixture = makeTempRepo();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  test("bad slug throws InvalidInputError with code INVALID_INPUT", () => {
    try {
      record({ repo: fixture.repo, body: "x", slug: "BadSlug", scope: "main" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidInputError);
      expect((e as InvalidInputError).code).toBe("INVALID_INPUT");
      expect((e as Error).message).toMatch(/bad slug/);
    }
  });

  test("bad scope throws InvalidInputError", () => {
    try {
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "Bad Scope" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidInputError);
      expect((e as InvalidInputError).code).toBe("INVALID_INPUT");
    }
  });

  test("empty body throws InvalidInputError", () => {
    try {
      record({ repo: fixture.repo, body: "" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidInputError);
    }
  });

  test("bad by attribution throws InvalidInputError", () => {
    try {
      record({ repo: fixture.repo, body: "x", slug: "a", scope: "main", by: "two\nlines" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidInputError);
    }
  });

  test("CRLF in MNEO_AUTHOR throws InvalidInputError (commit-header injection guard)", () => {
    // Without env validation a hostile env value lands directly in
    // GIT_AUTHOR_NAME and lets the agent forge commit headers
    // ("real-bot\nfake-trailer: evil"). Mirror the rules `by` enforces.
    const prev = process.env.MNEO_AUTHOR;
    process.env.MNEO_AUTHOR = "real-bot\nfake-trailer: evil";
    try {
      try {
        record({ repo: fixture.repo, body: "x", slug: "a", scope: "main" });
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InvalidInputError);
        expect((e as InvalidInputError).message).toMatch(/MNEO_AUTHOR/);
      }
    } finally {
      if (prev === undefined) {
        // biome-ignore lint/performance/noDelete: process.env requires delete
        delete process.env.MNEO_AUTHOR;
      } else {
        process.env.MNEO_AUTHOR = prev;
      }
    }
  });
});

describe("error contract — list", () => {
  let fixture: TempRepo;
  beforeEach(() => {
    fixture = makeTempRepo();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  test("bad prefix throws InvalidInputError", () => {
    try {
      list({ repo: fixture.repo, prefix: "Bad/" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidInputError);
      expect((e as InvalidInputError).code).toBe("INVALID_INPUT");
    }
  });
});

describe("error contract — forget", () => {
  let fixture: TempRepo;
  beforeEach(() => {
    fixture = makeTempRepo();
  });
  afterEach(() => {
    fixture.cleanup();
  });

  test("missing single-scope slug returns deleted=false without throwing", () => {
    const r = forget({ repo: fixture.repo, slug: "never-existed", scope: "main" });
    expect(r).toEqual({ deleted: false, scope: "main" });
  });

  test("bad slug throws InvalidInputError", () => {
    try {
      forget({ repo: fixture.repo, slug: "BAD!" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidInputError);
    }
  });
});

describe("error contract — findRepo", () => {
  test("no repo found from cwd throws RepoBrokenError", () => {
    const stray = mkdtempSync(join(tmpdir(), "no-repo-"));
    try {
      try {
        findRepo(stray);
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(RepoBrokenError);
        expect((e as RepoBrokenError).code).toBe("REPO_BROKEN");
        expect((e as Error).message).toMatch(/no git repo found/);
      }
    } finally {
      rmSync(stray, { recursive: true, force: true });
    }
  });
});

describe("error contract — context graceful degradation", () => {
  test("no repo → returns empty text instead of throwing", () => {
    const stray = mkdtempSync(join(tmpdir(), "no-repo-context-"));
    const prev = process.env.MNEO_REPO;
    // biome-ignore lint/performance/noDelete: process.env requires delete; assignment to undefined coerces to "undefined"
    delete process.env.MNEO_REPO;
    const cwd = process.cwd();
    try {
      process.chdir(stray);
      const r = context();
      expect(r.text).toBe("");
    } finally {
      process.chdir(cwd);
      if (prev !== undefined) process.env.MNEO_REPO = prev;
      rmSync(stray, { recursive: true, force: true });
    }
  });
});

describe("error contract — installHook", () => {
  let proj: string;
  beforeEach(() => {
    proj = mkdtempSync(join(tmpdir(), "init-hook-bad-json-"));
  });
  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
  });

  test("malformed settings.json throws InvalidInputError naming the path", () => {
    const claudeDir = join(proj, ".claude");
    const path = join(claudeDir, "settings.json");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(path, "{ broken json,,, }");
    try {
      installHook({ projectDir: findProjectDir(proj), hookCommand: "anything" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidInputError);
      expect((e as InvalidInputError).code).toBe("INVALID_INPUT");
      expect((e as Error).message).toContain(path);
    }
  });
});

describe("error contract — branchToScope strict (Slice 3)", () => {
  let fixture: TempRepo;
  beforeEach(() => {
    fixture = makeTempRepo();
    // checkout -b on unborn HEAD doesn't expose the branch to rev-parse;
    // an initial commit lets currentScope's branch detection actually fire.
    spawnSync("git", ["-C", fixture.repo, "commit", "--allow-empty", "-m", "init"], {
      encoding: "utf8",
    });
  });
  afterEach(() => {
    fixture.cleanup();
  });

  function checkout(repo: string, branch: string) {
    spawnSync("git", ["-C", repo, "checkout", "-b", branch], { encoding: "utf8" });
  }

  test("auto-detected branch with underscore throws InvalidInputError naming the recovery path", () => {
    checkout(fixture.repo, "feat/my_feature");
    try {
      record({ repo: fixture.repo, body: "x", slug: "a" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidInputError);
      expect((e as Error).message).toContain("feat/my_feature");
      expect((e as Error).message).toMatch(/MNEO_SCOPE/);
    }
  });

  test("auto-detected branch with dot throws InvalidInputError", () => {
    checkout(fixture.repo, "release/1.0");
    try {
      list({ repo: fixture.repo });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidInputError);
      expect((e as Error).message).toMatch(/release\/1\.0/);
    }
  });

  test("auto-detected branch with @ throws InvalidInputError", () => {
    checkout(fixture.repo, "feat/foo@bar");
    try {
      read({ repo: fixture.repo, slug: "a" });
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidInputError);
    }
  });

  test("branches in the alphabet still work (regression guard)", () => {
    checkout(fixture.repo, "feat/auth-oauth");
    const r = record({ repo: fixture.repo, body: "ok", slug: "a" });
    expect(r.scope).toBe("feat-auth-oauth");
  });
});

describe("error contract — findRepo via rev-parse (Slice 3, M1)", () => {
  test("non-repo dir with a stray HEAD file is rejected (no false-positive)", () => {
    const stray = mkdtempSync(join(tmpdir(), "stray-head-"));
    writeFileSync(join(stray, "HEAD"), "ref: refs/heads/main\n");
    const prev = process.env.MNEO_REPO;
    try {
      process.env.MNEO_REPO = stray;
      try {
        findRepo();
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(RepoBrokenError);
        expect((e as Error).message).toMatch(/non-repo/);
      }
    } finally {
      if (prev !== undefined) process.env.MNEO_REPO = prev;
      // biome-ignore lint/performance/noDelete: process.env requires delete; assignment to undefined coerces to "undefined"
      else delete process.env.MNEO_REPO;
      rmSync(stray, { recursive: true, force: true });
    }
  });
});

describe("error contract — base hierarchy", () => {
  test("every typed error is an instance of MneoError and Error", () => {
    const fixture = makeTempRepo();
    try {
      const cases: MneoError[] = [];
      try {
        read({ repo: fixture.repo, slug: "missing", scope: "main" });
      } catch (e) {
        cases.push(e as MneoError);
      }
      try {
        record({ repo: fixture.repo, body: "x", slug: "BAD" });
      } catch (e) {
        cases.push(e as MneoError);
      }
      try {
        findRepo(mkdtempSync(join(tmpdir(), "no-repo-base-")));
      } catch (e) {
        cases.push(e as MneoError);
      }
      expect(cases.length).toBe(3);
      for (const c of cases) {
        expect(c).toBeInstanceOf(MneoError);
        expect(c).toBeInstanceOf(Error);
        expect(typeof c.code).toBe("string");
      }
    } finally {
      fixture.cleanup();
    }
  });
});
