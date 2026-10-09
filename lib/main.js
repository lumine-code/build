const { spawn } = require("node:child_process");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { CompositeDisposable, Disposable } = require("lumine");
const { expandTarget, loadConfigTargets, loadProviderTargets } = require("./target-loader");

module.exports = {
  provideBackgroundTips() {
    return {
      packageName: "build",
      tips: ["You can run the active project target with {{ 'build:trigger' | keystroke }}"],
    };
  },

  activate() {
    this.deactivated = false;
    this.providers = [];
    this.targets = [];
    this.activeTarget = null;
    this.activeProcess = null;
    this.pendingStart = null;
    this.errors = [];
    this.errorIndex = -1;
    this.targetCommands = new CompositeDisposable();
    this.panel = null;
    this.statusElement = document.createElement("status-bar-tile");
    this.statusElement.className = "build-status";
    this.statusElement.textContent = "Build";
    this.statusElement.addEventListener("click", () => this.selectTarget());
    this.statusTooltip = lumine.tooltips.add(this.statusElement, {
      title: "Select build target",
      keyBindingCommand: "build:select-target",
    });
    this.selectListHost = null;
    this.selectList = null;

    this.subscriptions = new CompositeDisposable();
    this.services = {
      owner: this.subscriptions,
      disposed: false,
      maps: { build: new Map(), status: new Map(), busy: new Map(), linter: new Map() },
      edges: { build: [], status: [], busy: [], linter: [] },
      attachment: { tile: null, record: null, attaching: false, requested: false },
    };
    this.statusBar = this.busySignal = this.linter = null;
    this.statusTile = this.busyProvider = this.busyRecord = null;
    const owner = this.subscriptions;
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
        "build:toggle-panel": {
          description: "Show or hide the panel holding the build output.",
          didDispatch: () => this.ensurePanel().toggle(),
        },
        "build:clear": {
          description: "Empty the build output kept in the panel.",
          didDispatch: () => this.ensurePanel().clear(),
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
        if (this.subscriptions !== owner || owner.disposed) return;
        owner.add(
          editor.onDidSave(() => {
            if (
              this.subscriptions === owner &&
              !owner.disposed &&
              !this.pendingStart &&
              lumine.config.get("build.buildOnSave") &&
              this.projectPathForEditor(editor)
            ) {
              this.runActiveTarget();
            }
          }),
        );
      }),
      lumine.config.onDidChange("build.statusBar", () => this.updateStatusTile()),
      lumine.config.onDidChange("build.statusBarPriority", () => this.updateStatusTile()),
    );

    this.refreshTargets({ updateList: false });
  },

  deactivate() {
    const services = this.services;
    const owner = this.subscriptions;
    const host = this.selectListHost;
    const panel = this.panel;
    const tooltip = this.statusTooltip;
    const element = this.statusElement;
    const child = this.activeProcess;
    const busy = this.busyProvider;
    this.deactivated = true;
    this.services = null;
    this.subscriptions = null;
    this.selectListHost = this.selectList = this.panel = null;
    this.statusTooltip = null;
    this.activeProcess = this.busyProvider = this.busyRecord = null;
    this.statusTile = this.statusBar = this.busySignal = this.linter = null;
    this.providers = [];
    this.targets = [];
    this.pendingStart = null;
    this.refreshGeneration = (this.refreshGeneration ?? 0) + 1;
    clearTimeout(this.killTimer);
    this.killTimer = null;
    if (services) {
      services.disposed = true;
      for (const edges of Object.values(services.edges)) edges.length = 0;
    }
    if (child) {
      child.removeAllListeners();
      child.kill("SIGKILL");
    }
    busy?.dispose();
    if (services) {
      const tile = services.attachment.tile;
      services.attachment.tile = null;
      services.attachment.record = null;
      const resources = [...services.maps.linter.values()].map((record) => record.resource);
      for (const map of Object.values(services.maps)) map.clear();
      tile?.destroy();
      for (const resource of resources) resource?.dispose();
    }
    owner?.dispose();
    host?.destroy();
    panel?.destroy();
    tooltip?.dispose();
    element?.remove();
  },

  consumeBuildProvider(providerOrProviders) {
    const services = this.services;
    if (!services || services.disposed) return new Disposable();
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
    }
    if (this.services !== services || services.disposed) return new Disposable();
    const leases = new CompositeDisposable(
      ...providers.map((provider) => this.consumeService("build", provider)),
    );
    if (services && this.services === services) this.refreshTargets();
    return new Disposable(() => {
      leases.dispose();
      if (this.services === services && !services?.disposed) this.refreshTargets();
    });
  },

  consumeStatusBar(statusBar) {
    return this.consumeService("status", statusBar);
  },

  consumeBusySignal(busySignal) {
    return this.consumeService("busy", busySignal);
  },

  consumeLinterRegistry(registerIndie) {
    return this.consumeService("linter", registerIndie, () =>
      registerIndie({ name: "Build", markerInvalidation: "never" }),
    );
  },

  consumeService(name, value, create) {
    const services = this.services;
    if (!services || services.disposed) return new Disposable();
    const map = services.maps[name],
      edges = services.edges[name];
    let record = map.get(value);
    const fresh = !record;
    if (fresh) {
      record = { value, refs: 0, resource: null };
      map.set(value, record);
    }
    record.refs++;
    const edge = { record };
    edges.push(edge);
    const lease = new Disposable(() => {
      if (services.disposed || map.get(value) !== record) return;
      edges.splice(edges.indexOf(edge), 1);
      record.refs--;
      let resource = null,
        busy = null;
      if (record.refs === 0) {
        map.delete(value);
        resource = record.resource;
        record.resource = null;
        if (
          this.services === services &&
          name === "busy" &&
          (this.busyRecord === record || (!this.busyRecord && this.busySignal === value))
        ) {
          busy = this.busyProvider;
          this.busyProvider = this.busyRecord = null;
        }
      }
      this.syncServiceFields(services);
      resource?.dispose();
      busy?.dispose();
    });
    try {
      if (fresh && create) {
        const resource = create();
        if (this.services === services && !services.disposed && map.get(value) === record) {
          record.resource = resource;
        } else resource?.dispose();
      }
      this.syncServiceFields(services);
      return lease;
    } catch (error) {
      lease.dispose();
      throw error;
    }
  },

  syncServiceFields(services) {
    if (this.services !== services || services.disposed) return;
    this.providers = [...services.maps.build.keys()];
    this.statusBar = services.edges.status.at(-1)?.record.value ?? null;
    this.busySignal = services.edges.busy.at(-1)?.record.value ?? null;
    this.linter = services.edges.linter.at(-1)?.record.resource ?? null;
    this.updateStatusTile();
  },

  updateStatusTile() {
    const services = this.services;
    if (!services || services.disposed) return;
    const attachment = services.attachment;
    attachment.requested = true;
    if (attachment.attaching) return;
    attachment.attaching = true;
    try {
      while (attachment.requested && this.services === services && !services.disposed) {
        attachment.requested = false;
        const record = services.edges.status.at(-1)?.record;
        const priority = lumine.config.get("build.statusBarPriority");
        const enabled = lumine.config.get("build.statusBar");
        if (
          attachment.record === record &&
          attachment.tile &&
          enabled &&
          attachment.priority === priority
        )
          continue;
        const previous = attachment.tile;
        attachment.tile = attachment.record = null;
        this.statusTile = null;
        previous?.destroy();
        if (this.services !== services || services.disposed) break;
        if (attachment.requested) continue;
        if (!record || !enabled) continue;
        const tile = record.value.addLeftTile({ item: this.statusElement, priority });
        if (
          this.services !== services ||
          services.disposed ||
          attachment.requested ||
          services.edges.status.at(-1)?.record !== record ||
          !lumine.config.get("build.statusBar") ||
          lumine.config.get("build.statusBarPriority") !== priority
        ) {
          tile.destroy();
          continue;
        }
        attachment.tile = this.statusTile = tile;
        attachment.record = record;
        attachment.priority = priority;
      }
    } finally {
      attachment.attaching = false;
    }
  },

  context() {
    const editor = lumine.workspace.getActiveTextEditor();
    return {
      editor,
      filePath: editor?.getPath() ?? null,
      projectPath: this.projectPathForEditor(editor) ?? lumine.project.getPaths()[0] ?? null,
    };
  },

  ensurePanel() {
    if (this.panel == null) {
      const BuildPanel = require("./build-panel");
      this.panel = new BuildPanel();
    }
    return this.panel;
  },

  ensureSelectList() {
    if (this.selectListHost != null) return this.selectList;
    this.selectListHost = lumine.workspace.addSelectList(
      {
        emptyMessage: "No build targets found",
        getItemId: (target) => JSON.stringify([target.source, target.name]),
        search: { getFilterText: (target) => `${target.name} ${target.source}` },
        renderItem: (target) => ({ primary: target.name, secondary: target.source }),
        source: {
          mode: "snapshot",
          loadingMessage: "Loading build targets…",
          load: () => this.refreshTargets({ updateList: false }),
        },
        commands: {
          "build:choose-target": {
            description: "Use the selected target for subsequent builds.",
            didDispatch: (event) => this.setActiveTarget(event.detail.item),
          },
        },
        actions: [
          {
            command: "build:choose-target",
            context: "item",
            primary: true,
            disposition: "close",
            dispatch: "local",
          },
        ],
      },
      { className: "build-targets", crumb: "Build targets" },
    );
    this.selectList = this.selectListHost.getModel();
    return this.selectList;
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

  async refreshTargets({ notify = false, updateList = true } = {}) {
    if (this.deactivated) return [];
    const generation = (this.refreshGeneration = (this.refreshGeneration ?? 0) + 1);
    const context = this.context();
    if (!context.projectPath) {
      this.targets = [];
      this.activeTarget = null;
      this.syncTargetCommands();
      if (updateList) this.ensureSelectList().setItems([]);
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
      if (updateList) this.ensureSelectList().setItems(this.targets);
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
      if (updateList) this.ensureSelectList().setItems([]);
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

  selectTarget() {
    this.ensureSelectList();
    return this.selectListHost.show();
  },

  setActiveTarget(target) {
    this.activeTarget = target;
    this.updateStatus("idle");
  },

  async runActiveTarget() {
    const owner = this.subscriptions;
    if (this.deactivated || !owner || owner.disposed) return null;
    if (this.activeProcess || this.pendingStart) {
      lumine.notifications.addWarning("A build target is already starting or running.");
      return null;
    }
    const request = {};
    this.pendingStart = request;
    const current = () =>
      !this.deactivated &&
      !owner.disposed &&
      this.subscriptions === owner &&
      this.pendingStart === request;
    try {
      if (!this.activeTarget) await this.refreshTargets();
      if (!current()) return null;
      if (!this.activeTarget) {
        lumine.notifications.addWarning("No build target is available.", {
          detail: "Add .lumine-build.json to the project or install a build provider.",
        });
        return null;
      }
      if (!this.linter) {
        await lumine.packages.requestService("linter.registry", "^1.0.0");
        if (!current()) return null;
      }
      if (lumine.config.get("build.saveOnBuild")) {
        await Promise.all(
          lumine.workspace
            .getTextEditors()
            .filter((editor) => editor.getFileState() !== "unmodified")
            .map((editor) => editor.save()),
        );
        if (!current()) return null;
      }
      return this.runTarget(this.activeTarget);
    } catch (error) {
      if (!current()) return null;
      throw error;
    } finally {
      if (this.pendingStart === request) this.pendingStart = null;
    }
  },

  runTarget(target) {
    const owner = this.subscriptions;
    if (this.deactivated || !owner || owner.disposed) return null;
    const context = this.context();
    const expanded = expandTarget(target, context);
    const panel = this.ensurePanel();
    if (lumine.config.get("build.clearOnBuild")) panel.clear();
    if (["Show on Build", "Keep Visible"].includes(lumine.config.get("build.panelVisibility"))) {
      panel.show();
    }
    this.errors = [];
    this.errorIndex = -1;
    this.linter?.clearMessages();
    if (this.subscriptions !== owner || owner.disposed) return null;
    panel.setRunning(true, target.name);
    this.updateStatus("running");
    const busyRecord = this.services?.edges.busy.at(-1)?.record ?? null;
    const busy = this.busySignal?.create();
    if (this.subscriptions !== owner || owner.disposed) {
      busy?.dispose();
      return null;
    }
    this.busyRecord = busyRecord;
    this.busyProvider = busy;
    this.busyProvider?.add(`Building ${target.name}`);
    if (this.subscriptions !== owner || owner.disposed) return null;
    panel.append(`> ${expanded.cmd} ${expanded.args.join(" ")}\n`, "command");

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
      panel.append(text, "stdout");
    });
    child.stderr?.on("data", (data) => {
      const text = stderrDecoder.write(data);
      output += text;
      panel.append(text, "stderr");
    });
    child.on("error", (error) => this.finishRun(child, expanded, output, error));
    child.on("close", (code, signal) => {
      const tail = stdoutDecoder.end() + stderrDecoder.end();
      output += tail;
      if (tail) panel.append(tail);
      this.finishRun(child, expanded, output, null, code, signal);
    });
    return child;
  },

  finishRun(child, target, output, error, code = null, signal = null) {
    const owner = this.subscriptions;
    if (this.deactivated || !owner || owner.disposed) return;
    if (child && child !== this.activeProcess) return;
    if (!child && this.activeProcess) return;
    this.activeProcess = null;
    clearTimeout(this.killTimer);
    this.killTimer = null;
    const busy = this.busyProvider;
    this.busyProvider = this.busyRecord = null;
    busy?.dispose();
    if (this.subscriptions !== owner || owner.disposed) return;
    const panel = this.ensurePanel();
    panel.setRunning(false, target.name);
    if (error) panel.append(`${error.message}\n`, "stderr");
    try {
      const { parseErrors, toLinterMessages } = require("./error-parser");
      this.errors = parseErrors(output, target.errorMatch, target.cwd);
      this.linter?.setAllMessages(toLinterMessages(this.errors));
    } catch (parseError) {
      this.errors = [];
      lumine.notifications.addError(`Unable to parse diagnostics from ${target.name}.`, {
        detail: parseError.message,
      });
    }
    if (this.errors.length === 0) this.linter?.setAllMessages([]);
    const failed = Boolean(error) || (code != null && code !== 0);
    this.updateStatus(failed ? "failed" : signal ? "stopped" : "passed");
    if (failed && lumine.config.get("build.panelVisibility") === "Show on Error") panel.show();
    if (!failed && lumine.config.get("build.panelVisibility") === "Show on Error") panel.hide();
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
