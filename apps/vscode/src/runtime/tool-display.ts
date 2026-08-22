import type { ToolInputDisplay } from "@moonshot-ai/kimi-code-sdk";

import type { DisplayBlock } from "../../shared/legacy-sdk";

function toDisplayPath(input: string): string {
  return input.replaceAll("\\", "/");
}

export function describeToolDisplay(display: ToolInputDisplay): string {
  switch (display.kind) {
    case "command":
      return display.command;
    case "file_io":
      return `${display.operation} ${display.path}`;
    case "diff":
      return `Edit ${display.path}`;
    case "search":
      return `Search for ${display.query}`;
    case "url_fetch":
      return display.url;
    case "agent_call":
      return display.prompt;
    case "skill_call":
      return display.args ? `${display.skill_name} ${display.args}` : display.skill_name;
    case "todo_list":
      return "Update the task list";
    case "task":
      return display.description;
    case "task_stop":
      return display.task_description;
    case "plan_review":
      return display.plan;
    case "goal_start":
      return display.objective;
    case "generic":
      return display.summary;
  }
}

export function toLegacyDisplay(display: ToolInputDisplay): DisplayBlock[] {
  switch (display.kind) {
    case "command":
      return [{ type: "shell", language: display.language ?? "bash", command: display.command }];
    case "diff":
      return [{ type: "diff", path: toDisplayPath(display.path), old_text: display.before, new_text: display.after }];
    case "file_io":
      if (
        display.before !== undefined ||
        display.after !== undefined ||
        display.content !== undefined
      ) {
        return [{
          type: "diff",
          path: toDisplayPath(display.path),
          old_text: display.before ?? "",
          new_text: display.after ?? display.content ?? "",
        }];
      }
      return [{ type: "brief", text: describeToolDisplay(display) }];
    case "todo_list":
      return [{
        type: "todo",
        items: display.items.map((item) => ({
          title: item.title,
          status: item.status === "done" || item.status === "in_progress" ? item.status : "pending",
        })),
      }];
    case "search":
    case "url_fetch":
    case "agent_call":
    case "skill_call":
    case "task":
    case "task_stop":
    case "plan_review":
    case "goal_start":
    case "generic":
      return [{ type: "brief", text: describeToolDisplay(display) }];
  }
}

export function inferToolDisplay(
  name: string,
  rawArgs: unknown,
  workDir?: string,
): ToolInputDisplay | undefined {
  let args: Record<string, unknown> | undefined;
  if (typeof rawArgs === "string") {
    try {
      args = JSON.parse(rawArgs) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  } else if (typeof rawArgs === "object" && rawArgs !== null) {
    args = rawArgs as Record<string, unknown>;
  }
  if (!args) return undefined;

  const normalizePath = (p: string) => {
    if (workDir && !p.startsWith("/") && !/^[a-zA-Z]:[/\\]/.test(p)) {
      return `${workDir.replace(/[/\\]+$/, "")}/${p}`;
    }
    return p;
  };

  const toolName = name.toLowerCase().replaceAll("_", "");

  if (toolName === "writefile" || toolName === "write") {
    const path = typeof args["path"] === "string" ? normalizePath(args["path"]) : "";
    const content = typeof args["content"] === "string" ? args["content"] : "";
    return { kind: "file_io", operation: "write", path, before: "", after: content, content };
  }

  if (toolName === "strreplacefile" || toolName === "edit" || toolName === "replacefilecontent") {
    const path = typeof args["path"] === "string" ? normalizePath(args["path"]) : "";
    const before =
      typeof args["old_string"] === "string"
        ? args["old_string"]
        : typeof args["TargetContent"] === "string"
          ? args["TargetContent"]
          : "";
    const after =
      typeof args["new_string"] === "string"
        ? args["new_string"]
        : typeof args["ReplacementContent"] === "string"
          ? args["ReplacementContent"]
          : "";
    return { kind: "diff", path, before, after };
  }

  if (toolName === "settodolist" || toolName === "todolist" || toolName === "todos") {
    const rawTodos = Array.isArray(args["todos"]) ? args["todos"] : [];
    const items = rawTodos.map((item: any) => ({
      title: typeof item?.title === "string" ? item.title : "",
      status: typeof item?.status === "string" ? item.status : "pending",
    }));
    return { kind: "todo_list", items };
  }

  if (toolName === "bash" || toolName === "shell" || toolName === "runcommand") {
    const command =
      typeof args["command"] === "string"
        ? args["command"]
        : typeof args["CommandLine"] === "string"
          ? args["CommandLine"]
          : "";
    return { kind: "command", command, language: "bash" };
  }

  return undefined;
}
