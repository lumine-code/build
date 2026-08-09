const { CompositeDisposable } = require("lumine");

class BuildPanel {
  constructor() {
    this.element = document.createElement("section");
    this.element.className = "build-panel native-key-bindings";
    this.element.tabIndex = -1;
    this.heading = document.createElement("header");
    this.title = document.createElement("span");
    this.title.className = "build-panel-title";
    this.title.textContent = "Build output";
    this.stopButton = this.button("Stop", "build:stop");
    this.clearButton = this.button("Clear", "build:clear");
    this.closeButton = this.button("Close", "build:toggle-panel");
    this.heading.append(this.title, this.stopButton, this.clearButton, this.closeButton);
    this.output = document.createElement("pre");
    this.output.className = "build-output";
    this.output.tabIndex = 0;
    this.element.append(this.heading, this.output);
    this.subscriptions = new CompositeDisposable(
      lumine.config.onDidChange("build.panelOrientation", () => this.refresh()),
      lumine.config.onDidChange("build.panelVisibility", ({ newValue }) => {
        if (newValue === "Keep Visible") this.show();
        else if (newValue === "Hidden") this.hide();
      }),
    );
    if (lumine.config.get("build.panelVisibility") === "Keep Visible") this.show();
  }

  button(label, command) {
    const button = document.createElement("button");
    button.className = "btn btn-xs";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () =>
      lumine.commands.dispatch(lumine.views.getView(lumine.workspace), command),
    );
    return button;
  }

  createPanel() {
    const options = { item: this.element, priority: 100 };
    switch (lumine.config.get("build.panelOrientation")) {
      case "Top":
        return lumine.workspace.addTopPanel(options);
      case "Right":
        return lumine.workspace.addRightPanel(options);
      case "Left":
        return lumine.workspace.addLeftPanel(options);
      default:
        return lumine.workspace.addBottomPanel(options);
    }
  }

  show() {
    if (!this.panel) this.panel = this.createPanel();
    this.panel.show();
  }

  hide() {
    this.panel?.hide();
  }

  toggle() {
    if (this.panel?.isVisible()) this.hide();
    else this.show();
  }

  refresh() {
    const visible = this.panel?.isVisible() ?? false;
    this.panel?.destroy();
    this.panel = null;
    if (visible || lumine.config.get("build.panelVisibility") === "Keep Visible") this.show();
  }

  setRunning(running, targetName = "") {
    this.element.classList.toggle("is-running", running);
    this.stopButton.disabled = !running;
    this.title.textContent = targetName ? `Build — ${targetName}` : "Build output";
  }

  clear() {
    this.output.textContent = "";
  }

  append(text, stream = "stdout") {
    if (!text) return;
    const chunk = document.createElement("span");
    chunk.className = `build-output-${stream}`;
    chunk.textContent = text;
    this.output.appendChild(chunk);
    this.trim();
    if (lumine.config.get("build.scrollToEnd")) this.output.scrollTop = this.output.scrollHeight;
  }

  trim() {
    const limit = lumine.config.get("build.maxOutputLines");
    const text = this.output.textContent;
    const lines = text.split("\n");
    if (lines.length <= limit) return;
    this.output.replaceChildren(document.createTextNode(lines.slice(-limit).join("\n")));
  }

  getText() {
    return this.output.textContent;
  }

  destroy() {
    this.subscriptions.dispose();
    this.panel?.destroy();
    this.panel = null;
    this.element.remove();
  }
}

module.exports = BuildPanel;
