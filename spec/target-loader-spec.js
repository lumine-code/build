const fs = require("node:fs");
const path = require("node:path");
const temp = require("@lumine-code/temp").track();
const {
  expandTarget,
  findConfig,
  loadConfigTargets,
  normalizeTarget,
} = require("../lib/target-loader");

describe("build target loader", () => {
  let directory;

  beforeEach(() => {
    directory = fs.realpathSync.native(temp.mkdirSync("lumine-build-targets-"));
  });

  it("loads and normalizes JSON targets", async () => {
    fs.writeFileSync(
      path.join(directory, ".lumine-build.json"),
      JSON.stringify({
        targets: [
          { name: "Test", cmd: "node", args: ["--test"], cwd: "sub", env: { MODE: "test" } },
        ],
      }),
    );

    const targets = await loadConfigTargets(directory);

    expect(targets.length).toBe(1);
    expect(targets[0].name).toBe("Test");
    expect(targets[0].cwd).toBe(path.join(directory, "sub"));
    expect(targets[0].env).toEqual({ MODE: "test" });
  });

  it("loads YAML targets and gives JSON precedence", async () => {
    fs.writeFileSync(path.join(directory, ".lumine-build.yml"), "name: YAML\ncmd: node\n");
    expect(path.basename(await findConfig(directory))).toBe(".lumine-build.yml");
    fs.writeFileSync(path.join(directory, ".lumine-build.json"), '{"name":"JSON","cmd":"node"}');

    const targets = await loadConfigTargets(directory);

    expect(targets[0].name).toBe("JSON");
  });

  it("rejects malformed targets with their source name", () => {
    expect(() => normalizeTarget({ name: "Missing command" }, directory, "provider")).toThrowError(
      /provider.*cmd/u,
    );
  });

  it("expands project, editor, selection, and cursor variables", () => {
    const target = normalizeTarget(
      {
        name: "Expand",
        cmd: "run-{ROW}",
        args: ["{PROJECT_PATH}", "{FILE_ACTIVE_NAME}", "{SELECTION}", "{COLUMN}"],
        env: { ROOT: "{FILE_ACTIVE_PATH}" },
      },
      directory,
      "provider",
    );
    const editorPath = path.join(directory, "src", "main.js");
    const editor = {
      getPath: () => editorPath,
      getSelectedText: () => "selected",
      getCursorBufferPosition: () => ({ row: 2, column: 4 }),
    };

    const expanded = expandTarget(target, { projectPath: directory, editor });

    expect(expanded.cmd).toBe("run-3");
    expect(expanded.args).toEqual([directory, "main.js", "selected", "5"]);
    expect(expanded.env.ROOT).toBe(path.dirname(editorPath));
  });
});
