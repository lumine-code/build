const fs = require("node:fs/promises");
const path = require("node:path");
const YAML = require("yaml");

const CONFIG_NAMES = [".lumine-build.json", ".lumine-build.yaml", ".lumine-build.yml"];

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function findConfig(projectPath) {
  for (const name of CONFIG_NAMES) {
    const candidate = path.join(projectPath, name);
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

function validateStringArray(value, field, source) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`${source}: ${field} must be an array of strings`);
  }
  return value;
}

function normalizeTarget(rawTarget, projectPath, source, index = 0) {
  if (!rawTarget || typeof rawTarget !== "object" || Array.isArray(rawTarget)) {
    throw new TypeError(`${source}: target ${index + 1} must be an object`);
  }
  if (typeof rawTarget.cmd !== "string" || rawTarget.cmd.trim() === "") {
    throw new TypeError(`${source}: target ${index + 1} requires a non-empty cmd`);
  }
  const name = rawTarget.name ?? rawTarget.cmd;
  if (typeof name !== "string" || name.trim() === "") {
    throw new TypeError(`${source}: target ${index + 1} requires a non-empty name`);
  }
  if (
    rawTarget.env != null &&
    (typeof rawTarget.env !== "object" || Array.isArray(rawTarget.env))
  ) {
    throw new TypeError(`${source}: env must be an object`);
  }
  const env = {};
  for (const [key, value] of Object.entries(rawTarget.env ?? {})) {
    if (typeof value !== "string")
      throw new TypeError(`${source}: environment values must be strings`);
    env[key] = value;
  }

  return {
    name,
    cmd: rawTarget.cmd,
    args: validateStringArray(rawTarget.args, "args", source),
    cwd: path.resolve(projectPath, rawTarget.cwd ?? "."),
    env,
    shell: Boolean(rawTarget.shell),
    commandName: typeof rawTarget.commandName === "string" ? rawTarget.commandName : null,
    errorMatch: rawTarget.errorMatch ?? null,
    source,
  };
}

function targetsFromDocument(document, projectPath, source) {
  const rawTargets = Array.isArray(document) ? document : (document?.targets ?? [document]);
  if (!Array.isArray(rawTargets)) throw new TypeError(`${source}: targets must be an array`);
  return rawTargets
    .filter(Boolean)
    .map((target, index) => normalizeTarget(target, projectPath, source, index));
}

async function loadConfigTargets(projectPath) {
  const configPath = await findConfig(projectPath);
  if (!configPath) return [];
  const source = path.basename(configPath);
  const contents = await fs.readFile(configPath, "utf8");
  let document;
  try {
    document = configPath.endsWith(".json") ? JSON.parse(contents) : YAML.parse(contents);
  } catch (error) {
    throw new SyntaxError(`${source}: ${error.message}`, { cause: error });
  }
  return targetsFromDocument(document, projectPath, source);
}

async function loadProviderTargets(providers, context) {
  const targets = [];
  for (const provider of providers) {
    const provided = await provider.provide(context);
    const rawTargets = Array.isArray(provided) ? provided : [provided];
    for (const [index, target] of rawTargets.filter(Boolean).entries()) {
      targets.push(normalizeTarget(target, context.projectPath, provider.name, index));
    }
  }
  return targets;
}

function replaceVariables(value, variables) {
  return value.replace(/\{([A-Z_]+)\}/g, (match, name) =>
    Object.hasOwn(variables, name) ? variables[name] : match,
  );
}

function expandTarget(target, context) {
  const editor = context.editor;
  const filePath = editor?.getPath() ?? "";
  const cursor = editor?.getCursorBufferPosition();
  const variables = {
    PROJECT_PATH: context.projectPath,
    FILE_ACTIVE: filePath,
    FILE_ACTIVE_PATH: filePath ? path.dirname(filePath) : "",
    FILE_ACTIVE_NAME: filePath ? path.basename(filePath) : "",
    SELECTION: editor?.getSelectedText() ?? "",
    ROW: cursor ? String(cursor.row + 1) : "",
    COLUMN: cursor ? String(cursor.column + 1) : "",
  };
  return {
    ...target,
    cmd: replaceVariables(target.cmd, variables),
    args: target.args.map((argument) => replaceVariables(argument, variables)),
    cwd: replaceVariables(target.cwd, variables),
    env: Object.fromEntries(
      Object.entries(target.env).map(([key, value]) => [key, replaceVariables(value, variables)]),
    ),
  };
}

module.exports = {
  CONFIG_NAMES,
  expandTarget,
  findConfig,
  loadConfigTargets,
  loadProviderTargets,
  normalizeTarget,
  targetsFromDocument,
};
