const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("Build native pending input snapshot", () => {
  let root,
    main,
    previousPaths,
    first,
    second,
    editors,
    lease,
    saveLease,
    release,
    waiting,
    pending,
    child;

  async function closed(childProcess) {
    if (childProcess.exitCode != null || childProcess.signalCode != null)
      return childProcess.exitCode;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        childProcess.removeListener("close", onClose);
        childProcess.removeListener("error", onError);
        if (error) reject(error);
        else resolve(code);
      };
      const onClose = (code) => finish(null, code);
      const onError = (error) => finish(error);
      const timer = setTimeout(() => {
        childProcess.kill("SIGKILL");
        finish(new Error("Owned target did not close within ten seconds."));
      }, 10000);
      childProcess.once("close", onClose);
      childProcess.once("error", onError);
    });
  }
  async function until(condition) {
    const deadline = Date.now() + 10000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("Owned save did not reach its hold.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  beforeEach(async () => {
    jasmine.useRealClock();
    for (const method of ["openExternal", "openPath", "showItemInFolder", "openApplication"])
      spyOn(lumine.shell, method).and.returnValue(Promise.resolve());
    spyOn(lumine.application, "openWindow").and.returnValue(Promise.resolve());
    root = fs.mkdtempSync(path.join(os.tmpdir(), "build-input-snapshot-"));
    first = path.join(root, "first.txt");
    second = path.join(root, "second.txt");
    fs.writeFileSync(first, "first");
    fs.writeFileSync(second, "second");
    const targets = ["first", "second"].map((name) => ({
      name,
      cmd: "node",
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
        path.join(root, name + ".out"),
        "{FILE_ACTIVE}",
      ],
      shell: false,
    }));
    fs.writeFileSync(path.join(root, ".lumine-build.json"), JSON.stringify(targets));
    previousPaths = lumine.project.getPaths();
    lumine.project.setPaths([root]);
    lumine.config.set("build.saveOnBuild", true);
    lumine.config.set("build.buildOnSave", false);
    lumine.config.set("build.panelVisibility", "Hidden");
    jasmine.attachToDOM(lumine.workspace.getElement());
    editors = [await lumine.workspace.open(first)];
    lease = lumine.packages.serviceHub.provide("linter.registry", "1.0.0", () => ({
      setAllMessages() {},
      clearMessages() {},
      dispose() {},
    }));
    main = (await lumine.packages.activatePackage("build")).mainModule;
    await main.refreshTargets();
    main.setActiveTarget(main.targets.find((target) => target.name === "first"));
    waiting = false;
  });
  afterEach(async () => {
    release?.();
    if (pending) child = await pending;
    if (child) await closed(child);
    saveLease?.dispose();
    for (const editor of editors) editor.destroy();
    if (lumine.packages.isPackageActive("build")) await lumine.packages.deactivatePackage("build");
    if (lumine.packages.isPackageLoaded("build")) await lumine.packages.unloadPackage("build");
    lease?.dispose();
    lumine.project.setPaths(previousPaths);
    await lumine.fileWatchClient.settlePendingTeardown();
    const temporary = fs.realpathSync(os.tmpdir());
    const target = fs.realpathSync(root);
    const relative = path.relative(temporary, target);
    if (
      !relative ||
      path.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(".." + path.sep)
    )
      throw new Error("Fixture cleanup escaped the private temporary directory.");
    for (const file of ["first.txt", "second.txt", ".lumine-build.json", "first.out", "second.out"])
      if (fs.existsSync(path.join(target, file))) fs.unlinkSync(path.join(target, file));
    fs.rmdirSync(target);
    root = main = lease = saveLease = release = pending = child = null;
  });
  async function launch(hold) {
    if (hold) {
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      saveLease = editors[0].getBuffer().onWillSave(() => {
        waiting = true;
        return promise;
      });
      editors[0].setText("modified first");
    }
    const run = spyOn(main, "runActiveTarget").and.callThrough();
    lumine.commands.dispatch(lumine.workspace.getElement(), "build:trigger");
    expect(run).toHaveBeenCalledTimes(1);
    pending = run.calls.mostRecent().returnValue;
    if (hold) await until(() => waiting);
  }
  async function finish() {
    release?.();
    child = await pending;
    expect(await closed(child)).toBe(0);
  }
  it("keeps the requested target while the actual source save waits", async () => {
    await launch(true);
    main.setActiveTarget(main.targets.find((target) => target.name === "second"));
    await finish();
    expect(fs.existsSync(path.join(root, "first.out"))).toBeTrue();
    expect(fs.existsSync(path.join(root, "second.out"))).toBeFalse();
    expect(main.statusElement.textContent).toContain("first");
  });
  it("keeps the requested editor variables while another editor becomes active", async () => {
    await launch(true);
    editors.push(await lumine.workspace.open(second));
    expect(lumine.workspace.getActiveTextEditor()).toBe(editors[1]);
    await finish();
    expect(fs.readFileSync(path.join(root, "first.out"), "utf8")).toBe(first);
  });
  it("keeps the ordinary build command tied to its actual active file", async () => {
    await launch(false);
    await finish();
    expect(fs.readFileSync(path.join(root, "first.out"), "utf8")).toBe(first);
  });
});
