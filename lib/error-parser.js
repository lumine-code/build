const path = require("node:path");

function patternsFor(errorMatch) {
  if (!errorMatch) return [];
  return (Array.isArray(errorMatch) ? errorMatch : [errorMatch]).map((entry) => {
    const pattern = typeof entry === "string" ? entry : entry?.pattern;
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new TypeError("errorMatch entries require a non-empty pattern");
    }
    return {
      regex: new RegExp(pattern, "gmu"),
      severity: typeof entry === "object" ? entry.severity : null,
    };
  });
}

function normalizeSeverity(value) {
  const severity = String(value ?? "error").toLowerCase();
  if (severity.includes("warn")) return "warning";
  if (severity.includes("info") || severity.includes("note")) return "info";
  return "error";
}

function parseErrors(output, errorMatch, cwd) {
  const errors = [];
  for (const { regex, severity } of patternsFor(errorMatch)) {
    for (const match of output.matchAll(regex)) {
      const groups = match.groups ?? {};
      if (!groups.file) continue;
      const line = Math.max(1, Number.parseInt(groups.line ?? "1", 10) || 1);
      const column = Math.max(1, Number.parseInt(groups.column ?? groups.col ?? "1", 10) || 1);
      const endLine = Math.max(line, Number.parseInt(groups.endLine ?? String(line), 10) || line);
      const endColumn = Math.max(
        column,
        Number.parseInt(groups.endColumn ?? String(column + 1), 10) || column + 1,
      );
      errors.push({
        file: path.resolve(cwd, groups.file),
        line,
        column,
        endLine,
        endColumn,
        message: groups.message?.trim() || match[0].trim(),
        severity: normalizeSeverity(groups.severity ?? severity),
      });
    }
  }
  return errors;
}

function toLinterMessages(errors) {
  return errors.map((error) => ({
    severity: error.severity,
    excerpt: error.message,
    location: {
      file: error.file,
      position: [
        [error.line - 1, error.column - 1],
        [error.endLine - 1, error.endColumn - 1],
      ],
    },
  }));
}

module.exports = { parseErrors, patternsFor, toLinterMessages };
