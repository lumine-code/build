const { CompositeDisposable, Emitter } = require("lumine");

const URI = "lumine://build-output";
const STATE_LABELS = {
  idle: "Ready",
  running: "Running",
  passed: "Passed",
  failed: "Failed",
  stopped: "Stopped",
};

// A dock tab owns its presentation, never the process or its retained output.
class BuildPanel {
  constructor(model) {
    this.model = model;
    this.emitter = new Emitter();
    this.subscriptions = new CompositeDisposable(this.emitter);
    this.destroyed = false;
    this.element = document.createElement("section");
    this.element.className = "build-panel native-key-bindings";
    this.element.tabIndex = -1;
    this.element.setAttribute("aria-label", "Build output");

    this.heading = this.node("header", "build-panel-header");
    const state = this.node("span", "build-panel-state");
    state.setAttribute("role", "status");
    const dot = this.node("span", "build-panel-state-dot");
    dot.setAttribute("aria-hidden", "true");
    this.stateLabel = this.node("span", "build-panel-state-label");
    state.append(dot, this.stateLabel);
    this.title = this.node("span", "build-panel-title");
    this.summary = this.node("span", "build-panel-summary");
    const actions = this.node("div", "build-panel-actions");
    this.stopButton = this.button("Stop", () => this.dispatch("build:stop"));
    this.clearButton = this.button("Clear", () => this.dispatch("build:clear"));
    this.copyButton = this.button("Copy", () => lumine.clipboard.write(this.getText()));
    this.copyButton.title = "Copy all build output";
    actions.append(this.stopButton, this.clearButton, this.copyButton);
    this.heading.append(state, this.title, this.summary, actions);

    const body = this.node("div", "build-panel-body");
    this.output = this.node("pre", "build-output");
    this.output.tabIndex = 0;
    this.output.setAttribute("aria-label", "Build log");
    this.output.setAttribute("data-scrollbar", "auto");
    this.empty = this.node("div", "build-panel-empty");
    this.emptyTitle = this.node("div", "build-panel-empty-title");
    this.emptyDescription = document.createElement("p");
    this.empty.append(this.emptyTitle, this.emptyDescription);
    body.append(this.output, this.empty);
    this.element.append(this.heading, body);
    this.subscriptions.add(model.onDidChange((change) => this.update(change)));
    this.update({ type: "reset" });
  }

  node(tagName, className) {
    const element = document.createElement(tagName);
    element.className = className;
    return element;
  }

  button(label, action) {
    const button = document.createElement("button");
    button.className = "btn btn-xs";
    button.type = "button";
    button.textContent = label;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => {
      if (!this.destroyed) action();
    });
    return button;
  }

  dispatch(command) {
    lumine.commands.dispatch(this.element, command);
  }

  getElement() {
    return this.element;
  }

  getTitle() {
    return "Build Output";
  }

  getURI() {
    return URI;
  }

  getSingletonKey() {
    return URI;
  }

  getIconName() {
    return "tools";
  }

  getDefaultLocation() {
    return "bottom";
  }

  getAllowedLocations() {
    return ["bottom"];
  }

  getDefaultVisibility() {
    return "visible";
  }

  getPreferredHeight() {
    return 260;
  }

  serialize() {
    return { deserializer: "build/BuildPanel" };
  }

  onDidDestroy(callback) {
    return this.emitter.on("did-destroy", callback);
  }

  isDestroyed() {
    return this.destroyed;
  }

  async show() {
    if (this.destroyed) return;
    if (this.opening) return this.opening;
    const controller = new AbortController();
    this.openController = controller;
    const opening = lumine.workspace.open(this, {
      searchAllPanes: true,
      activatePane: false,
      pending: false,
      signal: controller.signal,
    });
    this.opening = opening;
    try {
      const item = await opening;
      if (!item || this.destroyed || controller.signal.aborted) return;
      lumine.workspace.getBottomDock().show();
      this.followOutput();
      return item;
    } finally {
      if (this.opening === opening) {
        this.opening = null;
        this.openController = null;
      }
    }
  }

  hide() {
    this.openController?.abort();
    this.openController = null;
    this.opening = null;
    // hide(item) only hides a dock with this active item, not another tab.
    lumine.workspace.hide(this);
  }

  toggle() {
    const pane = lumine.workspace.paneForItem(this);
    if (
      this.opening ||
      (pane?.getActiveItem() === this && lumine.workspace.getBottomDock().isVisible())
    ) {
      this.hide();
    } else {
      return this.show();
    }
  }

  focus() {
    (this.output.hidden ? this.element : this.output).focus({ preventScroll: true });
  }

  appendChunk(chunk) {
    const element = this.output.ownerDocument.createElement("span");
    element.className = `build-output-${chunk.stream}`;
    element.textContent = chunk.text;
    this.output.appendChild(element);
  }

  update(change) {
    if (change.type === "append" && !change.trimmed) {
      this.appendChunk(change.chunk);
    } else if (change.type === "reset" || change.trimmed) {
      this.output.replaceChildren();
      for (const chunk of this.model.chunks) this.appendChunk(chunk);
    }
    this.element.dataset.state = this.model.state;
    this.stateLabel.textContent = STATE_LABELS[this.model.state];
    this.title.textContent = this.model.targetName || "Build output";
    this.title.title = this.model.targetName || "Build output";
    this.summary.textContent = this.model.summary;
    const empty = this.getText().length === 0;
    this.empty.hidden = !empty;
    this.output.hidden = empty;
    this.emptyTitle.textContent =
      this.model.state === "running" ? "Waiting for output…" : "No build output";
    this.emptyDescription.textContent =
      this.model.state === "running"
        ? "The target is still running."
        : "Run a project target to see its output here.";
    this.stopButton.disabled = this.model.state !== "running";
    this.clearButton.disabled = empty;
    this.copyButton.disabled = empty;
    if (change.type !== "state") this.followOutput();
  }

  followOutput() {
    if (lumine.config.get("build.scrollToEnd")) this.output.scrollTop = this.output.scrollHeight;
  }

  setRunning(running, targetName = "") {
    if (running) this.model.start(targetName);
    else this.model.finish("stopped");
  }

  clear() {
    this.model.clear();
  }

  append(text, stream = "stdout") {
    this.model.append(text, stream);
  }

  getText() {
    return this.model.getText();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.openController?.abort();
    this.element.remove();
    this.emitter.emit("did-destroy");
    this.subscriptions.dispose();
  }
}

BuildPanel.URI = URI;
module.exports = BuildPanel;
