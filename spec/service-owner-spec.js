const { Disposable } = require("lumine");

describe("Build consumed service ownership", () => {
  let main, hub, consumers, providers, bars, StatusBarView;
  const target = { name: "Provided", cmd: "node", args: ["--version"] };
  const tiles = (bar) =>
    bar.getLeftTiles().filter((tile) => tile.getItem().matches?.(".build-status"));

  beforeEach(async () => {
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("status-bar");
    StatusBarView = lumine.packages.getActivePackage("status-bar").mainModule.statusBar.constructor;
    main = (await lumine.packages.activatePackage("build")).mainModule;
    // No target/process/open command is executed by these service-edge controls.
    spyOn(main, "refreshTargets").and.resolveTo([]);
    hub = new lumine.packages.serviceHub.constructor();
    consumers = [];
    providers = [];
    bars = [];
  });

  afterEach(async () => {
    consumers.forEach((consumer) => consumer.dispose());
    providers.forEach((provider) => provider.dispose());
    await lumine.packages.deactivatePackage("build");
    bars.forEach((bar) => bar.destroy());
  });

  function consume(service, method) {
    consumers.push(hub.consume(service, "^1.0.0", (value) => main[method](value)));
  }
  function provide(service, value) {
    const provider = hub.provide(service, "1.0.0", value);
    providers.push(provider);
    return provider;
  }
  function bar() {
    const value = new StatusBarView();
    bars.push(value);
    jasmine.attachToDOM(value.element);
    return value;
  }

  it("keeps a shared build provider until its final exact-payload lease ends", () => {
    consume("build.provider", "consumeBuildProvider");
    const provider = { name: "Controlled", provide: () => target };
    const first = provide("build.provider", provider),
      second = provide("build.provider", provider);
    expect(main.providers).toEqual([provider]);
    first.dispose();
    expect(main.providers).toEqual([provider]);
    second.dispose();
    expect(main.providers).toEqual([]);
  });

  it("keeps shared and distinct status payloads live without destroying borrowed bars", () => {
    lumine.config.set("build.statusBar", true);
    consume("status-bar", "consumeStatusBar");
    const firstBar = bar(),
      secondBar = bar();
    const first = provide("status-bar", firstBar),
      second = provide("status-bar", firstBar);
    first.dispose();
    expect(tiles(firstBar).length).toBe(1);
    const third = provide("status-bar", secondBar);
    second.dispose();
    expect(tiles(secondBar).length).toBe(1);
    expect(main.statusBar).toBe(secondBar);
    third.dispose();
    expect(tiles(secondBar).length).toBe(0);
  });

  it("keeps active busy work when one shared service lease is withdrawn", () => {
    consume("busy-signal", "consumeBusySignal");
    const work = { dispose: jasmine.createSpy("dispose work") };
    const busy = { create: () => work };
    const first = provide("busy-signal", busy),
      second = provide("busy-signal", busy);
    main.busyProvider = busy.create();
    first.dispose();
    expect(main.busySignal).toBe(busy);
    expect(main.busyProvider).toBe(work);
    expect(work.dispose).not.toHaveBeenCalled();
    second.dispose();
    expect(work.dispose).toHaveBeenCalledTimes(1);
    expect(main.busyProvider).toBeNull();
  });

  it("creates one owned linter per shared registry payload and releases every distinct linter", () => {
    consume("linter.registry", "consumeLinterRegistry");
    const linters = [];
    const register = () => {
      const linter = { dispose: jasmine.createSpy("dispose linter") };
      linters.push(linter);
      return linter;
    };
    const registry = jasmine.createSpy("register registry").and.callFake(register);
    const first = provide("linter.registry", registry),
      second = provide("linter.registry", registry);
    expect(registry).toHaveBeenCalledTimes(1);
    first.dispose();
    expect(main.linter).toBe(linters[0]);
    expect(linters[0].dispose).not.toHaveBeenCalled();
    second.dispose();
    expect(linters[0].dispose).toHaveBeenCalledTimes(1);
    const other = jasmine.createSpy("other registry").and.callFake(register);
    provide("linter.registry", registry);
    provide("linter.registry", other);
    main.deactivate();
    expect(linters.every((linter) => linter.dispose.calls.count() === 1)).toBe(true);
  });

  it("restores the last surviving exact status edge after A-B-A consumption", () => {
    lumine.config.set("build.statusBar", true);
    consume("status-bar", "consumeStatusBar");
    const a = bar(),
      b = bar();
    const firstA = provide("status-bar", a),
      edgeB = provide("status-bar", b),
      lastA = provide("status-bar", a);
    expect(tiles(a).length).toBe(1);
    expect(tiles(b).length).toBe(0);
    lastA.dispose();
    expect(main.statusBar).toBe(b);
    expect(tiles(b).length).toBe(1);
    edgeB.dispose();
    expect(main.statusBar).toBe(a);
    expect(tiles(a).length).toBe(1);
    firstA.dispose();
    expect(tiles(a).length).toBe(0);
  });

  it("retires an obsolete staged tile before relocating the same status element", () => {
    lumine.config.set("build.statusBar", true);
    consume("status-bar", "consumeStatusBar");
    const a = bar(),
      b = bar();
    const add = a.addLeftTile.bind(a);
    spyOn(a, "addLeftTile").and.callFake((options) => {
      const tile = add(options);
      provide("status-bar", b);
      return tile;
    });
    provide("status-bar", a);
    expect(tiles(a).length).toBe(0);
    expect(tiles(b).length).toBe(1);
    expect(main.statusElement.isConnected).toBe(true);
    expect(main.statusElement.closest("status-bar")).toBe(b.element);
  });

  it("does not use a copied retired editor observation callback", async () => {
    await lumine.packages.deactivatePackage("build");
    let retired = false;
    let onDidSave;
    const earlier = lumine.workspace.observeTextEditors((editor) => {
      if (!retired) {
        onDidSave = spyOn(editor, "onDidSave").and.callThrough();
        retired = true;
        main.deactivate();
      }
    });
    main = (await lumine.packages.activatePackage("build")).mainModule;
    try {
      const editor = await lumine.workspace.open();
      expect(retired).toBe(true);
      expect(onDidSave).not.toHaveBeenCalled();
      editor.destroy();
    } finally {
      earlier.dispose();
    }
  });

  it("does not publish a completed build into an activation created by busy cleanup", () => {
    main.busyProvider = new Disposable(() => {
      main.deactivate();
      main.activate();
    });
    const completed = { name: "Old completed", cwd: process.cwd(), errorMatch: null };
    main.finishRun(null, completed, "old output", null, 0);
    expect(main.panel).toBeNull();
    expect(main.statusElement.textContent).toBe("Build");
  });

  it("does not spawn a target after its optional busy factory retires the activation", async () => {
    const work = new Disposable();
    work.add = jasmine.createSpy("add busy work");
    const disposed = spyOn(work, "dispose").and.callThrough();
    main.busySignal = {
      create: () => {
        main.deactivate();
        return work;
      },
    };
    const child = main.runTarget({
      name: "Retired controlled target",
      cmd: "node",
      args: ["--version"],
      cwd: process.cwd(),
      env: {},
      shell: false,
    });
    // Original source starts only this harmless hidden Node child; await its
    // completion before cleanup so no process survives the failing control.
    if (child)
      await new Promise((resolve, reject) => {
        child.once("close", resolve);
        child.once("error", reject);
      });
    expect(child).toBeNull();
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(work.add).not.toHaveBeenCalled();
  });

  it("does not spawn after actual Busy Registry update observers retire Build during add", async () => {
    const busyMain = (await lumine.packages.activatePackage("busy-signal")).mainModule;
    const registry = busyMain.instance.registry;
    const create = spyOn(registry, "create").and.callThrough();
    const lease = main.consumeBusySignal({ create: () => registry.create() });
    const changed = registry.onDidUpdate(() => {
      if (registry.getTilesActive().length) main.deactivate();
    });
    let child;
    try {
      child = main.runTarget({
        name: "Actual retired busy target",
        cmd: "node",
        args: ["--version"],
        cwd: process.cwd(),
        env: {},
        shell: false,
      });
      if (child)
        await new Promise((resolve, reject) => {
          child.once("close", resolve);
          child.once("error", reject);
        });
      expect(child).toBeNull();
      expect(create.calls.mostRecent().returnValue.disposed).toBe(true);
      expect(registry.getTilesActive()).toEqual([]);
    } finally {
      changed.dispose();
      lease.dispose();
      await lumine.packages.deactivatePackage("busy-signal");
    }
  });
});
