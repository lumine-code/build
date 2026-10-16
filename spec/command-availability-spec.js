describe("Build command availability", () => {
  let main;
  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    main = (await lumine.packages.activatePackage("build")).mainModule;
    await main.refreshTargets();
  });
  afterEach(() => {
    main.activeTarget = null;
    main.activeProcess = null;
    main.pendingStart = null;
    main.errors = [];
  });
  it("reflects cached target, process and diagnostics without refreshing services", () => {
    const target = lumine.workspace.getElement(),
      has = (id) => lumine.commands.canDispatch(target, "build:" + id);
    const refresh = spyOn(main, "refreshTargets").and.throwError("query refreshed targets");
    expect(has("trigger")).toBe(false);
    expect(has("stop")).toBe(false);
    expect(has("next-error")).toBe(false);
    main.activeTarget = { name: "test" };
    expect(has("trigger")).toBe(true);
    main.pendingStart = {};
    expect(has("trigger")).toBe(false);
    expect(has("stop")).toBe(true);
    expect(main.stop()).toBe(true);
    expect(main.pendingStart).toBeNull();
    main.errors = [{}];
    expect(has("next-error")).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });
});
