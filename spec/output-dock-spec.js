const fs = require("node:fs");
const temp = require("@lumine-code/fs-temp").track();

describe("Build output dock", () => {
  let main, directory, editor, other, child;

  async function until(condition, message) {
    const deadline = Date.now() + 10000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(message);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async function closed(process) {
    if (process.exitCode != null || process.signalCode != null) return;
    await new Promise((resolve, reject) => {
      process.once("close", resolve);
      process.once("error", reject);
    });
  }

  async function startHeldBuild({ exitCode = 0 } = {}) {
    const target = {
      name: "Held output",
      cmd: "node",
      args: [
        "-e",
        `process.stdout.write('first output\\n'); process.stdin.on('data', () => process.stdout.write('second output\\n')); process.stdin.on('end', () => { process.exitCode = ${exitCode}; });`,
      ],
      cwd: directory,
      env: {},
      shell: false,
    };
    child = await main.runTarget(target, target);
    await until(
      () => main.ensurePanel().getText().includes("first output\n"),
      "The build did not produce its initial output.",
    );
    return child;
  }

  async function showOtherDockItem() {
    other = {
      element: document.createElement("div"),
      getElement() {
        return this.element;
      },
      getTitle: () => "Other output",
      getURI: () => "lumine://build-spec/other-output",
      getDefaultLocation: () => "bottom",
      getAllowedLocations: () => ["bottom"],
    };
    await lumine.workspace.open(other, { location: "bottom", activatePane: false });
    return lumine.workspace.paneForItem(other);
  }

  function delayOpening(panel) {
    const open = lumine.workspace.open.bind(lumine.workspace);
    let release;
    const opening = spyOn(lumine.workspace, "open").and.callFake((item, options) => {
      if (item !== panel) return open(item, options);
      return new Promise((resolve, reject) => {
        release = () => open(item, options).then(resolve, reject);
      });
    });
    const pending = panel.show();
    return {
      pending,
      signal: opening.calls.mostRecent().args[1].signal,
      release: () => release(),
    };
  }

  beforeEach(async () => {
    jasmine.useRealClock();
    directory = fs.realpathSync.native(temp.mkdirSync("lumine-build-dock-"));
    lumine.project.setPaths([directory]);
    lumine.config.set("build.panelVisibility", "Show on Build");
    lumine.config.set("build.clearOnBuild", true);
    lumine.config.set("build.scrollToEnd", true);
    lumine.config.set("build.maxOutputLines", 10000);
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("build")).mainModule;
    editor = await lumine.workspace.open();
    lumine.views.getView(editor).focus();
    child = other = null;
  });

  afterEach(async () => {
    if (child && child.exitCode == null && child.signalCode == null) {
      const completion = closed(child);
      child.kill("SIGKILL");
      await completion;
    }
    await lumine.packages.deactivatePackage("build");
    if (other) await lumine.workspace.paneForItem(other)?.destroyItem(other, true);
    if (editor && !editor.isDestroyed()) editor.destroy();
  });

  it("opens one bottom-only pane item without a separate workspace panel", async () => {
    const panel = main.ensurePanel();
    expect(panel.getDefaultLocation()).toBe("bottom");
    expect(panel.getAllowedLocations()).toEqual(["bottom"]);
    await panel.show();
    await panel.show();

    const dock = lumine.workspace.getBottomDock();
    expect(lumine.workspace.paneContainerForItem(panel)).toBe(dock);
    expect(dock.getPaneItems().filter((item) => item === panel).length).toBe(1);
    expect(panel.getElement().closest("lumine-dock")).toBe(dock.getElement());
    expect(lumine.workspace.getCenter().getPaneItems()).toContain(editor);
  });

  it("reveals automatic build output without moving focus from the editor", async () => {
    const editorView = lumine.views.getView(editor);
    expect(editorView.hasFocus()).toBe(true);
    await startHeldBuild();
    const panel = main.ensurePanel();
    await until(
      () => lumine.workspace.getBottomDock().isVisible() && lumine.workspace.paneForItem(panel),
      "The build did not reveal its output dock.",
    );

    expect(lumine.workspace.getBottomDock().getActivePaneItem()).toBe(panel);
    expect(editorView.hasFocus()).toBe(true);
    expect(lumine.workspace.getCenter().getActivePaneItem()).toBe(editor);
  });

  it("reveals Keep Visible on late activation and can focus its empty output", async () => {
    await lumine.packages.deactivatePackage("build");
    lumine.config.set("build.panelVisibility", "Keep Visible");
    spyOn(lumine.packages, "hasActivatedInitialPackages").and.returnValue(true);
    const editorView = lumine.views.getView(editor);
    editorView.focus();

    main = (await lumine.packages.activatePackage("build")).mainModule;
    const dock = lumine.workspace.getBottomDock();
    await until(
      () => main.panel && dock.isVisible() && dock.getActivePaneItem() === main.panel,
      "Late activation did not reveal Keep Visible build output.",
    );

    expect(editorView.hasFocus()).toBe(true);
    const panel = main.ensurePanel();
    expect(panel.getText()).toBe("");
    panel.focus();
    expect(panel.getElement().contains(document.activeElement)).toBe(true);
  });

  it("cancels a pending reveal when the output is hidden", async () => {
    const dock = lumine.workspace.getBottomDock();
    dock.hide();
    const panel = main.ensurePanel();
    const opening = delayOpening(panel);

    panel.hide();
    expect(opening.signal.aborted).toBe(true);
    opening.release();
    await opening.pending;

    expect(lumine.workspace.paneForItem(panel)).toBeUndefined();
    expect(dock.isVisible()).toBe(false);
  });

  it("cancels a pending reveal when its package deactivates", async () => {
    const dock = lumine.workspace.getBottomDock();
    dock.hide();
    const panel = main.ensurePanel();
    const opening = delayOpening(panel);

    await lumine.packages.deactivatePackage("build");
    expect(opening.signal.aborted).toBe(true);
    opening.release();
    await opening.pending;

    expect(lumine.workspace.paneForItem(panel)).toBeUndefined();
    expect(panel.getElement().isConnected).toBe(false);
    expect(dock.isVisible()).toBe(false);
  });

  it("retains running output after its tab is closed and reopened", async () => {
    await startHeldBuild();
    const previous = main.ensurePanel();
    await previous.show();
    await lumine.workspace.paneForItem(previous).destroyItem(previous, true);

    expect(main.activeProcess).toBe(child);
    child.stdin.write("continue\n");
    await until(
      () => main.ensureOutput().getText().includes("second output\n"),
      "The closed output tab stopped retaining live stdout.",
    );
    const panel = main.ensurePanel();
    await panel.show();
    expect(panel.getText()).toContain("first output\n");
    expect(panel.getText()).toContain("second output\n");
    expect(panel.getElement().dataset.state).toBe("running");
    expect(panel.stopButton.disabled).toBe(false);

    const completion = closed(child);
    child.stdin.end();
    await completion;
    expect(panel.getText()).toContain("first output\n");
    expect(panel.getText()).toContain("second output\n");
    expect(panel.getElement().dataset.state).toBe("passed");
    expect(panel.stopButton.disabled).toBe(true);
  });

  it("keeps hidden output available without revealing the dock automatically", async () => {
    lumine.config.set("build.panelVisibility", "Hidden");
    lumine.workspace.getBottomDock().hide();
    await startHeldBuild();

    expect(lumine.workspace.getBottomDock().isVisible()).toBe(false);
    const panel = main.ensurePanel();
    await panel.show();
    expect(panel.getText()).toContain("first output\n");
    expect(lumine.workspace.getBottomDock().isVisible()).toBe(true);
  });

  it("copies and clears retained output while the build continues streaming", async () => {
    await startHeldBuild();
    const panel = main.ensurePanel();
    await panel.show();
    const copy = spyOn(lumine.clipboard, "write");
    const retained = panel.getText();

    panel.copyButton.click();
    expect(copy).toHaveBeenCalledOnceWith(retained);
    panel.clearButton.click();
    expect(panel.getText()).toBe("");
    expect(panel.copyButton.disabled).toBe(true);
    expect(panel.clearButton.disabled).toBe(true);
    expect(panel.stopButton.disabled).toBe(false);
    expect(main.activeProcess).toBe(child);

    child.stdin.write("continue\n");
    await until(
      () => panel.getText().includes("second output\n"),
      "Clearing the output stopped the active build stream.",
    );
    expect(panel.getText()).not.toContain("first output");
    expect(panel.getElement().dataset.state).toBe("running");
    expect(panel.copyButton.disabled).toBe(false);
  });

  it("keeps bounded retained logs and stderr presentation after reopening", async () => {
    lumine.config.set("build.maxOutputLines", 100);
    const output = main.ensureOutput();
    output.append(Array.from({ length: 105 }, (_, index) => `output ${index}\n`).join(""));
    output.append("current error\n", "stderr");
    const previous = main.ensurePanel();
    await previous.show();
    await lumine.workspace.paneForItem(previous).destroyItem(previous, true);
    const panel = main.ensurePanel();
    await panel.show();

    expect(panel.getText().split("\n").length).toBe(100);
    expect(panel.getText()).not.toContain("output 0\n");
    expect(panel.getText()).toContain("output 104\n");
    expect(panel.output.querySelector(".build-output-stderr").textContent).toBe("current error\n");
  });

  it("does not hide another active dock item when a Show on Error build succeeds", async () => {
    lumine.config.set("build.panelVisibility", "Show on Error");
    const panel = main.ensurePanel();
    await panel.show();
    const otherPane = await showOtherDockItem();
    await startHeldBuild();
    expect(otherPane.getActiveItem()).toBe(other);

    const completion = closed(child);
    child.stdin.end("continue\n");
    await completion;

    expect(lumine.workspace.getBottomDock().isVisible()).toBe(true);
    expect(otherPane.getActiveItem()).toBe(other);
  });

  it("reveals a failed Show on Error build without moving editor focus", async () => {
    lumine.config.set("build.panelVisibility", "Show on Error");
    lumine.workspace.getBottomDock().hide();
    await startHeldBuild({ exitCode: 1 });
    expect(lumine.workspace.getBottomDock().isVisible()).toBe(false);

    const completion = closed(child);
    child.stdin.end();
    await completion;
    const panel = main.ensurePanel();
    await until(
      () =>
        lumine.workspace.getBottomDock().isVisible() &&
        lumine.workspace.getBottomDock().getActivePaneItem() === panel,
      "The failed build did not reveal its output dock.",
    );

    expect(lumine.views.getView(editor).hasFocus()).toBe(true);
    expect(panel.getElement().dataset.state).toBe("failed");
  });
});
