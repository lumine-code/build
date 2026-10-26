const fs = require("node:fs");
const path = require("node:path");
const temp = require("@lumine-code/fs-temp").track();
const YamlLoader = require("../lib/yaml-loader");
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

  it("loads YAML through its native parser while JSON never requests it", async () => {
    const loading = spyOn(YamlLoader.prototype, "load").and.callThrough();
    fs.writeFileSync(path.join(directory, ".lumine-build.yaml"), "name: YAML\ncmd: node\n");
    expect((await loadConfigTargets(directory))[0].name).toBe("YAML");
    expect(loading).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(directory, ".lumine-build.json"), '{"name":"JSON","cmd":"node"}');
    expect((await loadConfigTargets(directory))[0].name).toBe("JSON");
    expect(loading).toHaveBeenCalledTimes(1);
  });

  it("does not parse YAML when cancellation arrives during the import", async () => {
    fs.writeFileSync(path.join(directory, ".lumine-build.yaml"), "name: YAML\ncmd: node\n");
    let release;
    let entered;
    const importing = new Promise((resolve) => (entered = resolve));
    const parser = { parse: jasmine.createSpy("parse") };
    spyOn(YamlLoader.prototype, "load").and.callFake(() => {
      entered();
      return new Promise((resolve) => (release = resolve));
    });
    const controller = new AbortController();
    const pending = loadConfigTargets(directory, { signal: controller.signal });
    await importing;
    controller.abort();
    release(parser);
    await expectAsync(pending).toBeRejectedWith(controller.signal.reason);
    expect(parser.parse).not.toHaveBeenCalled();
  });

  it("rejects invalid YAML with the configuration filename", async () => {
    fs.writeFileSync(path.join(directory, ".lumine-build.yml"), "targets: [\n");
    await expectAsync(loadConfigTargets(directory)).toBeRejectedWithError(
      SyntaxError,
      /\.lumine-build.yml:/,
    );
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

  it("does not read an unrelated selection when the target does not use it", () => {
    const editor = {
      getPath: () => null,
      getCursorBufferPosition: () => null,
      getSelectedText: jasmine
        .createSpy("getSelectedText")
        .and.throwError("unbounded selection read"),
    };
    const target = normalizeTarget({ cmd: "node", args: ["--test"] }, directory, "provider");
    expect(expandTarget(target, { projectPath: directory, editor }).args).toEqual(["--test"]);
    expect(editor.getSelectedText).not.toHaveBeenCalled();
  });

  it("reads a requested selection once across command, args, cwd and environment", () => {
    const editor = {
      getPath: () => null,
      getCursorBufferPosition: () => null,
      getSelectedText: jasmine.createSpy("getSelectedText").and.returnValue("chosen"),
    };
    const target = normalizeTarget(
      {
        cmd: "{SELECTION}",
        args: ["{SELECTION}", "{SELECTION}"],
        cwd: "{SELECTION}",
        env: { VALUE: "{SELECTION}" },
      },
      directory,
      "provider",
    );
    const expanded = expandTarget(target, { projectPath: directory, editor });
    expect(expanded.cmd).toBe("chosen");
    expect(expanded.args).toEqual(["chosen", "chosen"]);
    expect(expanded.cwd).toBe(path.resolve(directory, "chosen"));
    expect(expanded.env.VALUE).toBe("chosen");
    expect(editor.getSelectedText).toHaveBeenCalledTimes(1);
  });

  it("rejects an explicitly requested oversized UTF-16 selection before materialization", () => {
    const limit = require("node:buffer").constants.MAX_STRING_LENGTH;
    const editor = {
      getPath: () => null,
      getCursorBufferPosition: () => null,
      getSelectedBufferRange: () => ({ start: { offset: 7 }, end: { offset: 7 + limit + 1 } }),
      getBuffer: () => ({ characterIndexForPosition: (point) => point.offset }),
      getSelectedText: jasmine
        .createSpy("getSelectedText")
        .and.throwError("unbounded selection read"),
    };
    const target = normalizeTarget({ cmd: "node", args: ["{SELECTION}"] }, directory, "provider");
    let failure;
    try {
      expandTarget(target, { projectPath: directory, editor });
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof RangeError).toBe(true);
    expect(failure.code).toBe("ERR_BUILD_SELECTION_TOO_LARGE");
    expect(failure.length).toBe(limit + 1);
    expect(editor.getSelectedText).not.toHaveBeenCalled();
  });
});
