import assert from "node:assert/strict";
import { test } from "node:test";
import { paths } from "./paths.ts";
import { extractPatchTargets } from "./patch-extract.ts";

const cwd = paths.join(paths.cwd, "fixture-project");

test("extracts add, update, delete, and move paths", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: a.txt",
    "+x",
    "*** Update File: src/b.ts",
    "*** Move to: src/c.ts",
    "@@",
    "-old",
    "+new",
    "*** Delete File: ../old.txt",
    "*** End Patch",
  ].join("\n");
  const result = extractPatchTargets(patch, cwd);
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.targets.map((target) => target.path),
    [
      paths.resolve(cwd, "a.txt"),
      paths.resolve(cwd, "src/b.ts"),
      paths.resolve(cwd, "src/c.ts"),
      paths.resolve(cwd, "../old.txt"),
    ],
  );
});

test("deduplicates paths and ignores body lines that look like markers", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: a.txt",
    "+*** End Patch",
    "+ *** End of File",
    "*** Update File: ./a.txt",
    "@@",
    " *** End of File",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");
  const result = extractPatchTargets(patch, cwd);
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.targets.map((target) => target.path),
    [paths.resolve(cwd, "a.txt")],
  );
});

test("fails closed on unknown markers, missing envelope, and empty paths", () => {
  const unknown = extractPatchTargets("*** Begin Patch\n*** Environment ID: x\n*** End Patch", cwd);
  assert.match(unknown.error ?? "", /Unsupported patch marker/);

  const missingBegin = extractPatchTargets("", cwd);
  assert.match(missingBegin.error ?? "", /Missing \*\*\* Begin Patch/);

  const beforeBegin = extractPatchTargets(
    "hello\n*** Begin Patch\n*** Add File: a.txt\n+x\n*** End Patch",
    cwd,
  );
  assert.match(beforeBegin.error ?? "", /Unexpected text before/);

  const missingEnd = extractPatchTargets("*** Begin Patch\n*** Add File: a.txt\n+x", cwd);
  assert.match(missingEnd.error ?? "", /Missing \*\*\* End Patch/);

  const empty = extractPatchTargets("*** Begin Patch\n*** Add File: \n*** End Patch", cwd);
  assert.ok(empty.error);
});

test("rejects a move outside an update section and a second move", () => {
  const outside = extractPatchTargets(
    "*** Begin Patch\n*** Add File: a.txt\n*** Move to: b.txt\n*** End Patch",
    cwd,
  );
  assert.match(outside.error ?? "", /Unexpected \*\*\* Move to/);

  const twice = extractPatchTargets(
    "*** Begin Patch\n*** Update File: a.txt\n*** Move to: b.txt\n*** Move to: c.txt\n@@\n-a\n+b\n*** End Patch",
    cwd,
  );
  assert.match(twice.error ?? "", /Unexpected \*\*\* Move to/);
});

test("handles CRLF patches", () => {
  const result = extractPatchTargets(
    "*** Begin Patch\r\n*** Add File: a.txt\r\n+x\r\n*** End Patch\r\n",
    cwd,
  );
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.targets.map((target) => target.path),
    [paths.resolve(cwd, "a.txt")],
  );
});

test("resolves paths literally, without expanding ~ or $HOME", () => {
  const result = extractPatchTargets(
    "*** Begin Patch\n*** Add File: ~/literal.txt\n+x\n*** End Patch",
    cwd,
  );
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.targets.map((target) => target.path),
    [paths.resolve(cwd, "~/literal.txt")],
  );
});
