const fs = require("node:fs");
const path = require("node:path");
const temp = require("@lumine-code/temp").track();

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

    lumine.commands.dispatch(workspaceElement, "spec:run-target");
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
    expect(main.selectList.isVisible()).toBe(false);
  });
});
