const YamlLoader = require("../lib/yaml-loader");

describe("build YAML parser loading", () => {
  it("shares concurrent native imports and preserves CommonJS parser identity", async () => {
    const loader = new YamlLoader();
    const imported = spyOn(loader, "importParser").and.callThrough();
    const first = loader.load();
    const second = loader.load();
    expect(first).toBe(second);
    const parser = await first;
    expect(parser).toBe(require("yaml"));
    expect(parser.parse("cmd: node\n")).toEqual({ cmd: "node" });
    expect(imported).toHaveBeenCalledTimes(1);
    expect(await loader.load()).toBe(parser);
  });

  it("retries a failed import without retaining the rejected promise", async () => {
    const loader = new YamlLoader();
    const nativeImport = loader.importParser.bind(loader);
    const failure = new Error("temporary parser failure");
    const imported = spyOn(loader, "importParser").and.returnValue(Promise.reject(failure));
    const first = loader.load();
    const second = loader.load();
    await expectAsync(first).toBeRejectedWith(failure);
    await expectAsync(second).toBeRejectedWith(failure);
    imported.and.callFake(nativeImport);
    expect((await loader.load()).parse("cmd: node\n")).toEqual({ cmd: "node" });
    expect(imported).toHaveBeenCalledTimes(2);
  });
});
