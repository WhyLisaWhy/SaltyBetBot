import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const workflow = await readFile(
  new URL("../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

describe("CI workflow triggers", () => {
  it("runs verification on branch pushes without a duplicate pull-request run", () => {
    expect(workflow).toMatch(/^  push:\s*$/m);
    expect(workflow).not.toMatch(/^  pull_request:\s*$/m);
  });
});
