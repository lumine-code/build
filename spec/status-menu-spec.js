describe("build status actions", () => {
  let main, element;
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("build")).mainModule;
    element = main.statusElement;
    lumine.workspace.getElement().appendChild(element);
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("build");
  });
  it("offers every status action and computes availability at each opening", () => {
    const commands = () =>
      lumine.contextMenu.templateForElement(element).filter((item) => item.command);
    expect(commands().map((item) => item.command)).toEqual([
      "build:trigger",
      "build:stop",
      "build:select-target",
      "build:refresh-targets",
      "build:toggle-panel",
      "build:clear",
      "build:next-error",
      "build:previous-error",
    ]);
    main.activeTarget = null;
    expect(commands()[0].enabled).toBe(false);
    main.activeTarget = { name: "Test" };
    expect(commands()[0].enabled).toBe(true);
    expect(commands()[0].mouseBindingLabel).toBe("MMB");
    expect(
      commands().find((item) => item.command === "build:select-target").mouseBindingLabel,
    ).toBe("LMB");
    expect(commands()[1].enabled).toBe(false);
    main.pendingStart = {};
    expect(commands()[1].enabled).toBe(true);
  });
  it("dispatches primary and middle actions, never executes the right button", () => {
    const select = spyOn(main, "selectTarget");
    const run = spyOn(main, "runActiveTarget");
    element.dispatchEvent(new MouseEvent("click", { button: 0 }));
    element.dispatchEvent(new MouseEvent("auxclick", { button: 1 }));
    element.dispatchEvent(new MouseEvent("click", { button: 2 }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it("disposes its menu with the package", async () => {
    const select = spyOn(main, "selectTarget");
    const run = spyOn(main, "runActiveTarget");
    await lumine.packages.deactivatePackage("build");
    expect(lumine.contextMenu.templateForElement(element)).toEqual([]);
    element.click();
    element.dispatchEvent(new MouseEvent("auxclick", { button: 1 }));
    expect(select).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
