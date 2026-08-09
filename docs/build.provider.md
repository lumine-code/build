Contribute project-aware targets to the build package.

| Metadata    | Value                      |
| ----------- | -------------------------- |
| Version     | `1.0.0`                    |
| Provided by | Tool and language packages |
| Consumed by | `build`                    |
| Owner       | `build`                    |

## Registration

Declare `build.provider` in `providedServices`. The service value is an object with a stable `name` and an asynchronous or synchronous `provide(context)` method.

## Contract

```ts
interface BuildProvider {
  name: string;
  provide(
    context: BuildContext,
  ): BuildTarget | BuildTarget[] | Promise<BuildTarget | BuildTarget[]>;
}

interface BuildContext {
  projectPath: string;
  filePath: string | null;
  editor: TextEditor | null;
}

interface BuildTarget {
  name: string;
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean;
  commandName?: string;
  errorMatch?: string | ErrorPattern | Array<string | ErrorPattern>;
}

interface ErrorPattern {
  pattern: string;
  severity?: "error" | "warning" | "info";
}
```

`BuildProvider.name`, `BuildProvider.provide`, `BuildTarget.name`, and `BuildTarget.cmd` are required. Every other field is optional.

## Minimal example

```js
provideBuild() {
  return {
    name: "example-tools",
    provide({ projectPath }) {
      return {
        name: "Tests",
        cmd: "npm",
        args: ["test"],
        cwd: projectPath,
      };
    },
  };
}
```

## Behavior

The consumer calls providers again when projects or providers change and before showing the target picker. Relative working directories resolve against the active project. Provider errors reject that refresh and appear as an editor notification.

Named diagnostic captures are `file`, `line`, `column` or `col`, `endLine`, `endColumn`, `severity`, and `message`. Only `file` is required for a match to become a diagnostic.

## Teardown

Service Hub disposes the consumer subscription when the provider deactivates. The build package then removes that provider and refreshes its targets. Providers retain ownership of any resources used to compute their returned targets.

## Versioning

New optional target fields are additive within `1.x`. Changing required fields, context fields, or target execution semantics requires a new service name.
