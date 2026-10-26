const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

describe("Build native multiline diagnostic ranges", () => {
  let root, editor, main, child, launch, registry, messages, previousPaths;

  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.resolveTo();
    spyOn(lumine.application, "openWindow").and.resolveTo();
    if (lumine.packages.isPackageActive("build")) await lumine.packages.deactivatePackage("build");
    if (lumine.packages.isPackageLoaded("build")) await lumine.packages.unloadPackage("build");
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "build-range-owned-")));
    fs.writeFileSync(path.join(root, "source.txt"), "0123456789\nabcdef\n");
    fs.writeFileSync(
      path.join(root, ".lumine-build.json"),
      JSON.stringify({
        name: "Owned diagnostic transport",
        cmd: "fixture-command-never-executed",
        args: [],
        errorMatch:
          "(?<file>[^:]+):(?<line>\\d+):(?<column>\\d+):(?<endLine>\\d+):(?<endColumn>\\d+): (?<message>.+)",
      }),
    );
    previousPaths = lumine.project.getPaths();
    lumine.project.setPaths([root]);
    lumine.config.set("build.saveOnBuild", false);
    lumine.config.set("build.buildOnSave", false);
    lumine.config.set("build.panelVisibility", "Hidden");
    messages = [];
    registry = lumine.packages.serviceHub.provide("linter.registry", "1.0.0", () => ({
      setAllMessages(value) {
        messages = value;
      },
      clearMessages() {},
      dispose() {},
    }));
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = jasmine.createSpy("owned child kill").and.returnValue(true);
    launch = spyOn(childProcess, "spawn").and.returnValue(child);
    jasmine.attachToDOM(lumine.workspace.getElement());
    editor = await lumine.workspace.open(path.join(root, "source.txt"));
    main = (await lumine.packages.activatePackage("build")).mainModule;
    await main.refreshTargets();
  });

  afterEach(async () => {
    child?.emit("close", 0, null);
    editor?.destroy();
    if (lumine.packages.isPackageActive("build")) await lumine.packages.deactivatePackage("build");
    if (lumine.packages.isPackageLoaded("build")) await lumine.packages.unloadPackage("build");
    registry?.dispose();
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    const temporary = fs.realpathSync.native(os.tmpdir());
    const target = fs.realpathSync.native(root);
    const relative = path.relative(temporary, target);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(".." + path.sep)
    )
      throw new Error("Diagnostic cleanup escaped the private temporary directory.");
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    root = editor = main = child = launch = registry = null;
  });

  async function report(output, expectedRange) {
    const run = spyOn(main, "runActiveTarget").and.callThrough();
    lumine.commands.dispatch(lumine.workspace.getElement(), "build:trigger");
    expect(run).toHaveBeenCalledTimes(1);
    expect(await run.calls.mostRecent().returnValue).toBe(child);
    expect(launch).toHaveBeenCalledTimes(1);
    const [command, args, options] = launch.calls.mostRecent().args;
    expect(command).toBe("fixture-command-never-executed");
    expect(args.length).toBe(0);
    expect(options.cwd).toBe(root);
    expect(options.shell).toBe(false);
    expect(options.windowsHide).toBe(true);
    // Feed the captured transport in two byte chunks; no OS child is launched.
    const bytes = Buffer.from(output);
    child.stdout.emit("data", bytes.subarray(0, 7));
    child.stdout.emit("data", bytes.subarray(7));
    child.emit("close", 0, null);
    expect(main.errors.length).toBe(1);
    expect(messages.length).toBe(1);
    expect(messages[0].location.file).toBe(editor.getPath());
    expect(messages[0].location.position).toEqual(expectedRange);
    expect(editor.getTextInBufferRange(messages[0].location.position)).toBe(
      editor.getTextInBufferRange(expectedRange),
    );
    expect(messages[0].excerpt).toBe("Owned diagnostic");
    expect(main.statusElement.dataset.state).toBe("passed");
  }

  it("retires only its automatic process and ignores stale callbacks after a manual replacement", async () => {
    const language = await lumine.packages.activatePackage("language-text");
    await language.resourceLoadPromise;
    const grammar = lumine.grammars.grammarForScopeName("text.plain");
    lumine.grammars.assignGrammar(editor, grammar);
    const grammarWatch = spyOn(editor, "onDidChangeGrammar").and.callThrough();
    const automatic = await main.runActiveTarget({ sourceEditor: editor });
    const staleCancellation = grammarWatch.calls.mostRecent().args[0];
    expect(automatic).toBe(child);
    const other = lumine.workspace.buildTextEditor();
    try {
      lumine.grammars.assignGrammar(other, grammar);
      lumine.grammars.assignGrammar(other, lumine.grammars.nullGrammar);
      expect(child.kill).not.toHaveBeenCalled();
      lumine.grammars.assignGrammar(editor, lumine.grammars.nullGrammar);
      expect(child.kill).toHaveBeenCalledOnceWith("SIGKILL");
      expect(main.activeProcess).toBeNull();

      const manual = new EventEmitter();
      manual.stdout = new EventEmitter();
      manual.stderr = new EventEmitter();
      manual.kill = jasmine.createSpy("manual child kill");
      launch.and.returnValue(manual);
      expect(await main.runActiveTarget()).toBe(manual);
      staleCancellation();
      child.stdout.emit("data", Buffer.from("source.txt:1:1:1:2: Stale diagnostic\n"));
      child.stderr.emit("data", Buffer.from("Stale failure\n"));
      child.emit("close", 1, null);
      expect(main.activeProcess).toBe(manual);
      expect(manual.kill).not.toHaveBeenCalled();
      expect(main.statusElement.dataset.state).toBe("running");
      expect(main.panel.getText()).not.toContain("Stale");
      expect(messages).toEqual([]);
      manual.stdout.emit("data", Buffer.from("current output\n"));
      manual.emit("close", 0, null);
      expect(main.panel.getText()).toContain("current output");
      expect(main.statusElement.dataset.state).toBe("passed");
    } finally {
      other.destroy();
    }
  });

  it("keeps an earlier end column on a later line", async () => {
    await report("source.txt:1:10:2:2: Owned diagnostic\n", [
      [0, 9],
      [1, 1],
    ]);
  });

  it("retains a later end column on a later line", async () => {
    await report("source.txt:1:2:2:5: Owned diagnostic\n", [
      [0, 1],
      [1, 4],
    ]);
  });

  it("still bounds a reversed end column within one line", async () => {
    await report("source.txt:1:5:1:2: Owned diagnostic\n", [
      [0, 4],
      [0, 4],
    ]);
  });
});
