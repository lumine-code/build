const fs = require("node:fs");
const path = require("node:path");
const temp = require("@lumine-code/fs-temp").track();

function closed(child) {
  return new Promise((resolve, reject) => {
    child.once("close", resolve);
    child.once("error", reject);
  });
}

describe("build", () => {
  let directory;
  let main;
  let workspaceElement;

  function writeTarget(target) {
    fs.writeFileSync(path.join(directory, ".lumine-build.json"), JSON.stringify(target));
  }

  beforeEach(async () => {
    directory = fs.realpathSync.native(temp.mkdirSync("lumine-build-integration-"));
    lumine.project.setPaths([directory]);
    lumine.config.set("build.saveOnBuild", false);
    lumine.config.set("build.panelVisibility", "Show on Build");
    lumine.config.set("build.panelOrientation", "Bottom");
    lumine.config.set("build.clearOnBuild", true);
    lumine.config.set("build.scrollToEnd", true);
    lumine.config.set("build.maxOutputLines", 10000);
    workspaceElement = lumine.views.getView(lumine.workspace);
    jasmine.attachToDOM(workspaceElement);
  });

  afterEach(async () => {
    await lumine.packages.deactivatePackage("build");
  });

  it("closes the center editor from build output while retaining the output panel", async () => {
    const editor = await lumine.workspace.open();
    const pack = await lumine.packages.activatePackage("build");
    const panel = pack.mainModule.ensurePanel();
    panel.show();
    panel.append("retained build output", "stdout");

    await lumine.commands.dispatch(panel.output, "core:close");

    expect(panel.panel.isVisible()).toBe(true);
    expect(panel.getText()).toBe("retained build output");
    expect(editor.isDestroyed()).toBe(true);
  });

  it("runs a project target and streams its output", async () => {
    writeTarget({ name: "Echo", cmd: "node", args: ["-e", "console.log('build-complete')"] });
    const pack = await lumine.packages.activatePackage("build");
    main = pack.mainModule;
    await main.refreshTargets();
    expect(main.activeTarget?.name).toBe("Echo");

    const child = await main.runActiveTarget();
    await closed(child);

    expect(main.panel.getText()).toContain("build-complete");
    expect(main.statusElement.dataset.state).toBe("passed");
  });

  it("saves every non-unmodified text editor before building", async () => {
    writeTarget({ name: "Save", cmd: "node", args: ["--version"] });
    const pack = await lumine.packages.activatePackage("build");
    main = pack.mainModule;
    await main.refreshTargets();
    lumine.config.set("build.saveOnBuild", true);

    const editors = ["unmodified", "modified", "conflicted", "removed"].map((fileState) => ({
      getFileState: () => fileState,
      save: jasmine.createSpy(`save-${fileState}`).and.returnValue(Promise.resolve()),
    }));
    spyOn(lumine.workspace, "getTextEditors").and.returnValue(editors);
    spyOn(main, "runTarget").and.returnValue("started");

    expect(await main.runActiveTarget()).toBe("started");
    expect(editors[0].save).not.toHaveBeenCalled();
    expect(editors[1].save).toHaveBeenCalled();
    expect(editors[2].save).toHaveBeenCalled();
    expect(editors[3].save).toHaveBeenCalled();
  });

  it("stops a running target and cleans up its process", async () => {
    writeTarget({ name: "Long", cmd: "node", args: ["-e", "setInterval(() => {}, 1000)"] });
    const pack = await lumine.packages.activatePackage("build");
    main = pack.mainModule;
    await main.refreshTargets();
    expect(main.activeTarget?.name).toBe("Long");
    const child = await main.runActiveTarget();
    const finished = closed(child);

    expect(main.stop()).toBe(true);
    await finished;
    expect(main.statusElement.dataset.state).toBe("stopped");
  });

  it("accepts targets from the build provider service", async () => {
    const pack = await lumine.packages.activatePackage("build");
    main = pack.mainModule;
    const subscription = main.consumeBuildProvider({
      name: "spec-provider",
      provide: () => ({ name: "Provided", cmd: "node", args: ["--version"] }),
    });
    await main.refreshTargets();

    expect(main.activeTarget.name).toBe("Provided");
    subscription.dispose();
    await main.refreshTargets();
    expect(main.targets.length).toBe(0);
  });

  it("registers and runs a target-specific command", async () => {
    writeTarget({
      name: "Command",
      cmd: "node",
      args: ["-e", "console.log('command-target')"],
      commandName: "spec:run-target",
    });
    const pack = await lumine.packages.activatePackage("build");
    main = pack.mainModule;
    await main.refreshTargets();
    expect(main.activeTarget?.commandName).toBe("spec:run-target");

    await lumine.commands.dispatch(workspaceElement, "spec:run-target");
    const child = main.activeProcess;
    expect(child).not.toBeNull();
    await closed(child);

    expect(main.panel.getText()).toContain("command-target");
    expect(main.statusElement.dataset.state).toBe("passed");
  });

  it("loads and confirms the target picker through its source and primary action", async () => {
    writeTarget([
      { name: "First", cmd: "node", args: ["--version"] },
      { name: "Second", cmd: "node", args: ["--version"] },
    ]);
    const pack = await lumine.packages.activatePackage("build");
    main = pack.mainModule;

    await main.selectTarget();
    const targets = main.selectList.getItems();
    expect(targets.map(({ name }) => name)).toEqual(["First", "Second"]);
    expect(main.selectList.getSource().mode).toBe("snapshot");
    expect(main.selectList.getItemId(targets[1])).toBe(
      JSON.stringify([".lumine-build.json", "Second"]),
    );

    await main.selectList.selectItem(targets[1]);
    expect((await main.selectList.confirmSelection()).status).toBe("success");
    expect(main.activeTarget).toBe(targets[1]);
    expect(main.selectListHost.isVisible()).toBe(false);
  });

  describe("pending build ownership", () => {
    const deferred = () => {
      let resolve, reject;
      const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      return { promise, resolve, reject };
    };

    beforeEach(async () => {
      writeTarget({ name: "Pending", cmd: "node", args: ["--version"] });
      ({ mainModule: main } = await lumine.packages.activatePackage("build"));
      await main.refreshTargets();
      main.linter = null;
    });

    it("does not start after deactivation while linter discovery waits", async () => {
      const service = deferred();
      spyOn(lumine.packages, "requestService").and.returnValue(service.promise);
      const run = spyOn(main, "runTarget").and.returnValue("started");
      const pending = main.runActiveTarget();
      await lumine.packages.deactivatePackage("build");
      service.resolve();
      expect(await pending).toBeNull();
      expect(run).not.toHaveBeenCalled();
      expect(main.panel).toBeNull();
    });

    it("does not start after deactivation while the editor save waits", async () => {
      const sourcePath = path.join(directory, "source.js");
      fs.writeFileSync(sourcePath, "old text");
      const editor = await lumine.workspace.open(sourcePath);
      editor.setText("new text");
      const saving = deferred();
      const saveStarted = deferred();
      const save = spyOn(editor, "save").and.callFake(() => {
        saveStarted.resolve();
        return saving.promise;
      });
      spyOn(lumine.packages, "requestService").and.resolveTo();
      const run = spyOn(main, "runTarget").and.returnValue("started");
      lumine.config.set("build.saveOnBuild", true);
      const pending = main.runActiveTarget();
      await saveStarted.promise;
      expect(save).toHaveBeenCalledTimes(1);
      await lumine.packages.deactivatePackage("build");
      saving.resolve();
      expect(await pending).toBeNull();
      expect(run).not.toHaveBeenCalled();
    });

    it("owns only one start while service discovery is pending", async () => {
      const service = deferred();
      spyOn(lumine.packages, "requestService").and.returnValue(service.promise);
      const run = spyOn(main, "runTarget").and.returnValue("started");
      const first = main.runActiveTarget();
      const second = main.runActiveTarget();
      service.resolve();
      expect(await first).toBe("started");
      expect(await second).toBeNull();
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("does not clear or start a replacement activation's pending build", async () => {
      const oldService = deferred();
      const newService = deferred();
      const discovery = spyOn(lumine.packages, "requestService").and.returnValues(
        oldService.promise,
        newService.promise,
      );
      const oldMain = main;
      const oldRun = spyOn(oldMain, "runTarget").and.returnValue("started");
      const oldPending = oldMain.runActiveTarget();
      await lumine.packages.deactivatePackage("build");
      ({ mainModule: main } = await lumine.packages.activatePackage("build"));
      await main.refreshTargets();
      main.linter = null;
      const run = main === oldMain ? oldRun : spyOn(main, "runTarget").and.returnValue("started");
      const pending = main.runActiveTarget();
      oldService.resolve();
      expect(await oldPending).toBeNull();
      const repeated = main.runActiveTarget();
      newService.resolve();
      expect(await pending).toBe("started");
      expect(await repeated).toBeNull();
      expect(discovery).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("ignores an obsolete discovery failure after deactivation", async () => {
      const service = deferred();
      spyOn(lumine.packages, "requestService").and.returnValue(service.promise);
      const run = spyOn(main, "runTarget");
      const pending = main.runActiveTarget();
      const settled = pending.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await lumine.packages.deactivatePackage("build");
      service.reject(new Error("Old linter failed"));
      expect(await settled).toEqual({ value: null });
      expect(run).not.toHaveBeenCalled();
    });

    it("preserves a current discovery failure and allows a later retry", async () => {
      const error = new Error("Current linter failed");
      const discovery = spyOn(lumine.packages, "requestService").and.rejectWith(error);
      const run = spyOn(main, "runTarget").and.returnValue("started");
      await expectAsync(main.runActiveTarget()).toBeRejectedWith(error);
      discovery.and.resolveTo();
      expect(await main.runActiveTarget()).toBe("started");
      expect(run).toHaveBeenCalledTimes(1);
    });

    it("does not recursively queue another build from its own save", async () => {
      const sourcePath = path.join(directory, "source.js");
      fs.writeFileSync(sourcePath, "old text");
      const editor = await lumine.workspace.open(sourcePath);
      editor.setText("new text");
      spyOn(lumine.packages, "requestService").and.resolveTo();
      const run = spyOn(main, "runTarget").and.returnValue("started");
      const warnings = spyOn(lumine.notifications, "addWarning");
      lumine.config.set("build.saveOnBuild", true);
      lumine.config.set("build.buildOnSave", true);
      expect(await main.runActiveTarget()).toBe("started");
      expect(fs.readFileSync(sourcePath, "utf8")).toBe("new text");
      expect(run).toHaveBeenCalledTimes(1);
      expect(warnings).not.toHaveBeenCalled();
    });
  });
});
