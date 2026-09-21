import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/publish-community-records.yml", import.meta.url), "utf8");
const script = workflow.split("        run: |\n")[1].replace(/^          /gm, "");

function run(scenario) {
  return spawnSync("bash", ["-e", "-c", `
    gh() {
      case "$1 $2" in
        "api "*)
          if [[ "$SCENARIO" == api-error ]]; then return 1; fi
          if [[ "$SCENARIO" == invalid ]]; then echo null;
          elif [[ "$SCENARIO" == empty || "$SCENARIO" == raced && "$pr_url" == raced ]]; then echo 0;
          else echo 1; fi ;;
        "pr list") [[ "$SCENARIO" != existing ]] || echo https://github.com/example/repo/pull/1 ;;
        "pr create")
          echo create >&2
          if [[ "$SCENARIO" == raced ]]; then echo raced; return 1; fi
          if [[ "$SCENARIO" == create-error ]]; then return 1; fi
          echo https://github.com/example/repo/pull/1 ;;
        "pr merge") echo merge ;;
        *) return 99 ;;
      esac
      return 0
    }
    ${script}
  `], { encoding: "utf8", env: { ...process.env, SCENARIO: scenario, REPOSITORY: "example/repo", BASE_BRANCH: "master", HEAD_BRANCH: "backup" } });
}

describe("record publication", () => {
  it("skips already-published records", () => {
    const result = run("empty");
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("create");
    expect(result.stdout).not.toContain("merge");
  });
  for (const scenario of ["new", "existing"]) {
    it(`enables auto-merge for ${scenario} pending records`, () => {
      const result = run(scenario);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("merge");
    });
  }
  it("accepts a confirmed concurrent publication", () => {
    const result = run("raced");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("published during");
  });
  for (const scenario of ["api-error", "invalid", "create-error"]) {
    it(`preserves ${scenario} as a failure`, () => {
      expect(run(scenario).status).not.toBe(0);
    });
  }
});
