const { spawn } = require("node:child_process");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { CompositeDisposable, Disposable } = require("lumine");
const BuildPanel = require("./build-panel");
const { expandTarget, loadConfigTargets, loadProviderTargets } = require("./target-loader");
const { parseErrors, toLinterMessages } = require("./error-parser");

module.exports = {
  activate() {
    this.deactivated = false;
    this.providers = [];
    this.targets = [];
    this.activeTarget = null;
    this.activeProcess = null;
    this.errors = [];
    this.errorIndex = -1;
    this.targetCommands = new CompositeDisposable();
    this.panel = new BuildPanel();
    this.statusElement = document.createElement("status-bar-tile");
    this.statusElement.className = "build-status";
    this.statusElement.textContent = "Build";
    this.statusElement.addEventListener("click", () => this.selectTarget());
    this.statusTooltip = lumine.tooltips.add(this.statusElement, {
      title: "Select build target",
      keyBindingCommand: "build:select-target",
    });
    this.selectList = lumine.workspace.buildSelectList({
      className: "build-targets",
      crumb: "Build targets",
      emptyMessage: "No build targets found",
      filterKeyForItem: (target) => `${target.name} ${target.source}`,
      elementForItem: (target) => this.elementForTarget(target),
      didConfirmSelection: (target) => {
        this.selectList.hide();
        this.setActiveTarget(target);
      },
      didCancelSelection: () => this.selectList.hide(),
      willShow: () => this.refreshTargets(),
    });

    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(
      this.targetCommands,
      lumine.commands.add("lumine-workspace", {
        "build:trigger": {
          description: "Run the target the project is currently set to build.",
          didDispatch: () => this.runActiveTarget(),
        },
        "build:stop": {
          description: "Kill the build that is running now.",
          didDispatch: () => this.stop(),
        },
        "build:toggle-panel": () => this.panel.toggle(),
        "build:clear": {
          description: "Empty the build output kept in the panel.",
          didDispatch: () => this.panel.clear(),
        },
        "build:select-target": {
          description: "Choose which of the project's targets Trigger builds.",
          didDispatch: () => this.selectTarget(),
        },
        "build:refresh-targets": {
          description: "Read the project's build files again for new targets.",
          didDispatch: () => this.refreshTargets({ notify: true }),
        },
        "build:next-error": {
          description: "Open the file and line of the next error the build reported.",
          didDispatch: () => this.openError(1),
        },
        "build:previous-error": {
          description: "Open the file and line of the previous error reported.",
          didDispatch: () => this.openError(-1),
        },
      }),
      lumine.project.onDidChangePaths(() => this.refreshTargets()),
      lumine.workspace.observeTextEditors((editor) => {
        this.subscriptions.add(
          editor.onDidSave(() => {
            if (lumine.config.get("build.buildOnSave") && this.projectPathForEditor(editor)) {
              this.runActiveTarget();
            }
          }),
        );
      }),
      lumine.config.onDidChange("build.statusBar", () => this.updateStatusTile()),
      lumine.config.onDidChange("build.statusBarPriority", () => this.updateStatusTile()),
    );

    this.refreshTargets();
  },

  deactivate() {
    this.deactivated = true;
    this.refreshGeneration = (this.refreshGeneration ?? 0) + 1;
    clearTimeout(this.killTimer);
    this.killTimer = null;
    if (this.activeProcess) {
      const child = this.activeProcess;
      this.activeProcess = null;
      child.removeAllListeners();
      child.kill("SIGKILL");
    }
    this.busyProvider?.dispose();
    this.busyProvider = null;
    this.statusTile?.destroy();
    this.statusTile = null;
    this.linter?.dispose();
    this.linter = null;
    this.subscriptions.dispose();
    this.selectList.destroy();
    this.panel.destroy();
    this.statusTooltip?.dispose();
    this.statusElement.remove();
    this.providers = [];
    this.targets = [];
  },

  consumeBuildProvider(providerOrProviders) {
    const providers = Array.isArray(providerOrProviders)
      ? providerOrProviders
      : [providerOrProviders];
    for (const provider of providers) {
      if (
        !provider ||
        typeof provider.name !== "string" ||
        typeof provider.provide !== "function"
      ) {
        throw new TypeError("build.provider requires name and provide");
      }
      if (!this.providers.includes(provider)) this.providers.push(provider);
    }
    this.refreshTargets();
    return new Disposable(() => {
      this.providers = this.providers.filter((provider) => !providers.includes(provider));
      if (!this.deactivated) this.refreshTargets();
    });
  },

  consumeStatusBar(statusBar) {
    this.statusBar = statusBar;
    this.updateStatusTile();
    return new Disposable(() => {
      this.statusTile?.destroy();
      this.statusTile = null;
      this.statusBar = null;
    });
  },

  consumeBusySignal(busySignal) {
    this.busySignal = busySignal;
    return new Disposable(() => {
      this.busyProvider?.dispose();
      this.busyProvider = null;
      this.busySignal = null;
    });
  },

  consumeLinterRegistry(registerIndie) {
    this.linter = registerIndie({ name: "Build", markerInvalidation: "never" });
    return new Disposable(() => {
      this.linter?.dispose();
      this.linter = null;
    });
  },

  updateStatusTile() {
    this.statusTile?.destroy();
    this.statusTile = null;
    if (!this.statusBar || !lumine.config.get("build.statusBar")) return;
    this.statusTile = this.statusBar.addLeftTile({
      item: this.statusElement,
      priority: lumine.config.get("build.statusBarPriority"),
    });
  },

  elementForTarget(target) {
    const element = document.createElement("li");
    const name = document.createElement("span");
    name.className = "primary-line";
    name.textContent = target.name;
    const source = document.createElement("span");
    source.className = "secondary-line";
    source.textContent = target.source;
    element.append(name, source);
    return element;
  },

  context() {
    const editor = lumine.workspace.getActiveTextEditor();
    return {
      editor,
      filePath: editor?.getPath() ?? null,
      projectPath: this.projectPathForEditor(editor) ?? lumine.project.getPaths()[0] ?? null,
    };
  },

  projectPathForEditor(editor) {
    const filePath = editor?.getPath();
    if (!filePath) return null;
    const normalizedFile = path.resolve(filePath);
    return (
      lumine.project
        .getPaths()
        .map((projectPath) => path.resolve(projectPath))
        .sort((left, right) => right.length - left.length)
        .find(
          (projectPath) =>
            normalizedFile === projectPath ||
            normalizedFile.startsWith(`${projectPath}${path.sep}`),
        ) ?? null
    );
  },

  async refreshTargets({ notify = false } = {}) {
    if (this.deactivated) return [];
    const generation = (this.refreshGeneration = (this.refreshGeneration ?? 0) + 1);
    const context = this.context();
    if (!context.projectPath) {
      this.targets = [];
      this.activeTarget = null;
      this.syncTargetCommands();
      this.selectList.update({ items: [] });
      return [];
    }

    try {
      const [configTargets, providerTargets] = await Promise.all([
        loadConfigTargets(context.projectPath),
        loadProviderTargets(this.providers, context),
      ]);
      if (this.deactivated || generation !== this.refreshGeneration) return this.targets;
      this.targets = [...configTargets, ...providerTargets];
      const previous = this.activeTarget;
      this.activeTarget =
        this.targets.find(
          (target) => target.name === previous?.name && target.source === previous?.source,
        ) ??
        this.targets[0] ??
        null;
      this.selectList.update({ items: this.targets });
      this.syncTargetCommands();
      this.updateStatus("idle");
      if (notify) {
        lumine.notifications.addSuccess(
          `Found ${this.targets.length} build target${this.targets.length === 1 ? "" : "s"}.`,
        );
      }
      return this.targets;
    } catch (error) {
      if (this.deactivated || generation !== this.refreshGeneration) return this.targets;
      this.targets = [];
      this.activeTarget = null;
      this.syncTargetCommands();
      this.selectList.update({ items: [] });
      lumine.notifications.addError("Unable to load build targets.", {
        detail: error.message,
        dismissable: true,
      });
      return [];
    }
  },

  syncTargetCommands() {
    this.targetCommands.dispose();
    this.subscriptions?.remove(this.targetCommands);
    this.targetCommands = new CompositeDisposable();
    this.subscriptions?.add(this.targetCommands);
    const workspace = lumine.views.getView(lumine.workspace);
    for (const target of this.targets) {
      if (
        !target.commandName ||
        !/^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9-]*$/u.test(target.commandName)
      ) {
        continue;
      }
      this.targetCommands.add(
        lumine.commands.add(workspace, target.commandName, () => {
          this.setActiveTarget(target);
          this.runActiveTarget();
        }),
      );
    }
  },

  async selectTarget() {
    await this.refreshTargets();
    this.selectList.show();
  },

  setActiveTarget(target) {
    this.activeTarget = target;
    this.updateStatus("idle");
  },

  async runActiveTarget() {
    if (this.activeProcess) {
      lumine.notifications.addWarning("A build target is already running.");
      return null;
    }
    if (!this.activeTarget) await this.refreshTargets();
    if (!this.activeTarget) {
      lumine.notifications.addWarning("No build target is available.", {
        detail: "Add .lumine-build.json to the project or install a build provider.",
      });
      return null;
    }
    if (lumine.config.get("build.saveOnBuild")) {
      await Promise.all(
        lumine.workspace
          .getTextEditors()
          .filter((editor) => editor.isModified())
          .map((editor) => editor.save()),
      );
    }
    return this.runTarget(this.activeTarget);
  },

  runTarget(target) {
    const context = this.context();
    const expanded = expandTarget(target, context);
    if (lumine.config.get("build.clearOnBuild")) this.panel.clear();
    if (["Show on Build", "Keep Visible"].includes(lumine.config.get("build.panelVisibility"))) {
      this.panel.show();
    }
    this.errors = [];
    this.errorIndex = -1;
    this.linter?.clearMessages();
    this.panel.setRunning(true, target.name);
    this.updateStatus("running");
    this.busyProvider = this.busySignal?.create();
    this.busyProvider?.add(`Building ${target.name}`);
    this.panel.append(`> ${expanded.cmd} ${expanded.args.join(" ")}\n`, "command");

    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let output = "";
    let child;
    try {
      child = spawn(expanded.cmd, expanded.args, {
        cwd: expanded.cwd,
        env: { ...process.env, ...expanded.env },
        shell: expanded.shell,
        windowsHide: true,
      });
    } catch (error) {
      this.finishRun(null, expanded, output, error);
      return null;
    }
    this.activeProcess = child;
    child.stdout?.on("data", (data) => {
      const text = stdoutDecoder.write(data);
      output += text;
      this.panel.append(text, "stdout");
    });
    child.stderr?.on("data", (data) => {
      const text = stderrDecoder.write(data);
      output += text;
      this.panel.append(text, "stderr");
    });
    child.on("error", (error) => this.finishRun(child, expanded, output, error));
    child.on("close", (code, signal) => {
      const tail = stdoutDecoder.end() + stderrDecoder.end();
      output += tail;
      if (tail) this.panel.append(tail);
      this.finishRun(child, expanded, output, null, code, signal);
    });
    return child;
  },

  finishRun(child, target, output, error, code = null, signal = null) {
    if (child && child !== this.activeProcess) return;
    if (!child && this.activeProcess) return;
    this.activeProcess = null;
    clearTimeout(this.killTimer);
    this.killTimer = null;
    this.busyProvider?.dispose();
    this.busyProvider = null;
    this.panel.setRunning(false, target.name);
    if (error) this.panel.append(`${error.message}\n`, "stderr");
    try {
      this.errors = parseErrors(output, target.errorMatch, target.cwd);
    } catch (parseError) {
      this.errors = [];
      lumine.notifications.addError(`Unable to parse diagnostics from ${target.name}.`, {
        detail: parseError.message,
      });
    }
    this.linter?.setAllMessages(toLinterMessages(this.errors));
    const failed = Boolean(error) || (code != null && code !== 0);
    this.updateStatus(failed ? "failed" : signal ? "stopped" : "passed");
    if (failed && lumine.config.get("build.panelVisibility") === "Show on Error") this.panel.show();
    if (!failed && lumine.config.get("build.panelVisibility") === "Show on Error")
      this.panel.hide();
    if (error) {
      lumine.notifications.addError(`Unable to run ${target.name}.`, { detail: error.message });
    }
  },

  stop({ force = false } = {}) {
    const child = this.activeProcess;
    if (!child) return false;
    child.kill(force ? "SIGKILL" : "SIGTERM");
    if (!force) {
      clearTimeout(this.killTimer);
      this.killTimer = setTimeout(() => {
        if (this.activeProcess === child) child.kill("SIGKILL");
      }, 2000);
    }
    return true;
  },

  updateStatus(state) {
    this.statusElement.dataset.state = state;
    const targetName = this.activeTarget?.name ?? "Build";
    const symbols = { running: "●", passed: "✓", failed: "✕", stopped: "■", idle: "" };
    this.statusElement.textContent = `${symbols[state] ?? ""} ${targetName}`.trim();
    this.statusElement.title = `Build target: ${targetName} (${state})`;
  },

  async openError(direction) {
    if (this.errors.length === 0) return null;
    this.errorIndex = (this.errorIndex + direction + this.errors.length) % this.errors.length;
    const error = this.errors[this.errorIndex];
    return lumine.workspace.open(error.file, {
      initialLine: error.line - 1,
      initialColumn: error.column - 1,
      searchAllPanes: true,
    });
  },
};
