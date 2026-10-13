module.exports = class YamlLoader {
  importParser() {
    return import("yaml");
  }

  load() {
    this.pending ??= Promise.resolve()
      .then(() => this.importParser())
      .then((namespace) => {
        const parser = namespace.default ?? namespace;
        if (typeof parser.parse !== "function") throw new TypeError("Invalid YAML parser.");
        return parser;
      })
      .catch((error) => {
        this.pending = null;
        throw error;
      });
    return this.pending;
  }
};
