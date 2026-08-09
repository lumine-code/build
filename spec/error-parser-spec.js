const path = require("node:path");
const { parseErrors, patternsFor, toLinterMessages } = require("../lib/error-parser");

describe("build error parser", () => {
  it("extracts named file positions, severity, and messages", () => {
    const output = "src/main.js:12:7: warning: Unexpected value";
    const errors = parseErrors(
      output,
      "(?<file>[^:]+):(?<line>\\d+):(?<column>\\d+): (?<severity>\\w+): (?<message>.+)",
      process.cwd(),
    );

    expect(errors.length).toBe(1);
    expect(errors[0].file).toBe(path.resolve("src/main.js"));
    expect(errors[0].line).toBe(12);
    expect(errors[0].column).toBe(7);
    expect(errors[0].severity).toBe("warning");
    expect(errors[0].message).toBe("Unexpected value");
  });

  it("converts matches into current linter registry messages", () => {
    const [message] = toLinterMessages([
      {
        file: path.resolve("file.js"),
        line: 2,
        column: 3,
        endLine: 2,
        endColumn: 5,
        message: "Failure",
        severity: "error",
      },
    ]);

    expect(message.location.position).toEqual([
      [1, 2],
      [1, 4],
    ]);
    expect(message.excerpt).toBe("Failure");
  });

  it("rejects error patterns without a pattern string", () => {
    expect(() => patternsFor({ severity: "warning" })).toThrowError(/pattern/u);
  });
});
