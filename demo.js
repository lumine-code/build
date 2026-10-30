// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: ["language-javascript", "busy-signal"],
  viewport: { width: 1100, height: 730 },
  async before() {},
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("build-sample/signal.js");
    await lumine.project.setPaths([fixture("build-sample")]);
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Run a project target and inspect its actual process output.",
      timeout: 60000,
      async run(context) {
        const { lumine } = context;
        {
          const b = lumine.packages.getActivePackage("build").mainModule;
          await b.refreshTargets();
          await b.runActiveTarget();
          lumine.workspace.getBottomDock().setState({ size: 260 });
        }
      },
      ready({ lumine }) {
        const panel = document.querySelector(".build-panel");
        const dock = lumine.workspace.getBottomDock();
        return Boolean(
          dock.isVisible() &&
          dock.getElement().contains(panel) &&
          panel?.dataset.state === "passed" &&
          panel.querySelector(".build-panel-title")?.textContent === "Process samples" &&
          panel.querySelector(".build-output")?.textContent.includes("Mean amplitude: 0.42"),
        );
      },
    },
  ],
  async cleanup() {},
};
