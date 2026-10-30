describe("Build output startup restoration", () => {
  let pack;

  async function loadUnactivatedPackage() {
    if (lumine.packages.getLoadedPackage("build"))
      await lumine.packages.unloadPackage("build", { serialize: false });
    pack = lumine.packages.loadPackage("build");
    pack.initializeForExternalUse("output restoration spec");
    return pack.mainModule;
  }

  beforeEach(async () => {
    jasmine.useRealClock();
    lumine.config.set("build.panelVisibility", "Show on Build");
    jasmine.attachToDOM(lumine.workspace.getElement());
    await loadUnactivatedPackage();
  });

  afterEach(async () => {
    if (lumine.packages.getLoadedPackage("build"))
      await lumine.packages.unloadPackage("build", { serialize: false });
  });

  it("keeps a restored output pane when package activation follows", async () => {
    const main = pack.mainModule;
    const panel = main.deserializeBuildPanel();
    await lumine.workspace.open(panel, { activatePane: false });
    expect(panel.serialize()).toEqual({ deserializer: "build/BuildPanel" });
    expect(lumine.workspace.paneContainerForItem(panel)).toBe(lumine.workspace.getBottomDock());

    await lumine.packages.activatePackage("build");

    expect(main.ensurePanel()).toBe(panel);
    expect(lumine.workspace.getBottomDock().getPaneItems()).toContain(panel);
  });

  it("retires a restored pane if the package unloads before activation", async () => {
    const panel = pack.mainModule.deserializeBuildPanel();
    await lumine.workspace.open(panel, { activatePane: false });

    await lumine.packages.unloadPackage("build", { serialize: false });

    expect(lumine.workspace.paneForItem(panel)).toBeUndefined();
    expect(panel.getElement().isConnected).toBe(false);
  });

  it("restores the dock shell in a new generation without stale output or running state", async () => {
    const previous = pack.mainModule.deserializeBuildPanel();
    previous.append("output from the previous session", "stdout");
    previous.setRunning(true, "Previous target");
    const state = previous.serialize();

    const currentMain = await loadUnactivatedPackage();
    const panel = currentMain.deserializeBuildPanel(state);
    await lumine.packages.activatePackage("build");
    await panel.show();

    expect(currentMain.ensurePanel()).toBe(panel);
    expect(panel).not.toBe(previous);
    expect(panel.getText()).toBe("");
    expect(panel.getElement().dataset.state).toBe("idle");
    expect(panel.stopButton.disabled).toBe(true);
  });
});
