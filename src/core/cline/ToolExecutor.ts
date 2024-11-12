import { Anthropic } from "@anthropic-ai/sdk";
import { serializeError } from "serialize-error";
import { TerminalManager } from "../../integrations/terminal/TerminalManager";
import { UrlContentFetcher } from "../../services/browser/UrlContentFetcher";
import { BrowserSession } from "../../services/browser/BrowserSession";
import { DiffViewProvider } from "../../integrations/editor/DiffViewProvider";
import { WebviewCommunicator } from "./WebviewCommunicator";
import { showOmissionWarning } from "../../integrations/editor/detect-omission";
import { formatResponse } from "../prompts/responses";
import { fileExistsAtPath } from "../../utils/fs";
import { getReadablePath } from "../../utils/path";
import * as path from "path";
import delay from "delay";
import { extractTextFromFile } from "../../integrations/misc/extract-text";
import { listFiles } from "../../services/glob/list-files";
import { regexSearchFiles } from "../../services/ripgrep";
import { parseSourceCodeForDefinitionsTopLevel } from "../../services/tree-sitter";
import { BrowserAction, browserActions, ClineSayTool } from "../../shared/ExtensionMessage";
import { ToolResponse } from "./types";

const ALLOWED_AUTO_EXECUTE_COMMANDS = [
  'npm',
  'npx',
  'tsc',
  'git log',
  'git diff',
  'git show',
  'list'
] as const;

export class ToolExecutor {
  private terminalManager: TerminalManager;
  private urlContentFetcher: UrlContentFetcher;
  private browserSession: BrowserSession;
  private diffViewProvider: DiffViewProvider;
  private webviewCommunicator: WebviewCommunicator;
  private cwd: string;
  private alwaysAllowReadOnly: boolean;
  private alwaysAllowWrite: boolean;
  private alwaysAllowExecute: boolean;
  private didEditFile: boolean = false;

  constructor(
    terminalManager: TerminalManager,
    urlContentFetcher: UrlContentFetcher,
    browserSession: BrowserSession,
    diffViewProvider: DiffViewProvider,
    webviewCommunicator: WebviewCommunicator,
    cwd: string,
    alwaysAllowReadOnly: boolean,
    alwaysAllowWrite: boolean,
    alwaysAllowExecute: boolean
  ) {
    this.terminalManager = terminalManager;
    this.urlContentFetcher = urlContentFetcher;
    this.browserSession = browserSession;
    this.diffViewProvider = diffViewProvider;
    this.webviewCommunicator = webviewCommunicator;
    this.cwd = cwd;
    this.alwaysAllowReadOnly = alwaysAllowReadOnly;
    this.alwaysAllowWrite = alwaysAllowWrite;
    this.alwaysAllowExecute = alwaysAllowExecute;
  }

  protected isAllowedCommand(command?: string): boolean {
    if (!command) {
      return false;
    }
    // Check for command chaining characters
    if (command.includes('&&') ||
      command.includes(';') ||
      command.includes('||') ||
      command.includes('|') ||
      command.includes('$(') ||
      command.includes('`')) {
      return false;
    }
    const trimmedCommand = command.trim().toLowerCase();
    return ALLOWED_AUTO_EXECUTE_COMMANDS.some(prefix => 
      trimmedCommand.startsWith(prefix.toLowerCase())
    );
  }

  async executeCommandTool(command: string): Promise<[boolean, ToolResponse]> {
    const terminalInfo = await this.terminalManager.getOrCreateTerminal(this.cwd);
    terminalInfo.terminal.show();
    const process = this.terminalManager.runCommand(terminalInfo, command);

    let userFeedback: { text?: string; images?: string[] } | undefined;
    let didContinue = false;
    const sendCommandOutput = async (line: string): Promise<void> => {
      try {
        const { response, text, images } = await this.webviewCommunicator.ask("command_output", line);
        if (response === "yesButtonClicked") {
          // proceed while running
        } else {
          userFeedback = { text, images };
        }
        didContinue = true;
        process.continue();
      } catch {
        // This can only happen if this ask promise was ignored, so ignore this error
      }
    };

    let result = "";
    process.on("line", (line) => {
      result += line + "\n";
      if (!didContinue) {
        sendCommandOutput(line);
      } else {
        this.webviewCommunicator.say("command_output", line);
      }
    });

    let completed = false;
    process.once("completed", () => {
      completed = true;
    });

    process.once("no_shell_integration", async () => {
      await this.webviewCommunicator.say("shell_integration_warning");
    });

    await process;
    await delay(50);
    result = result.trim();

    if (userFeedback) {
      await this.webviewCommunicator.say("user_feedback", userFeedback.text, userFeedback.images);
      return [
        true,
        formatResponse.toolResult(
          `Command is still running in the user's terminal.${
            result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
          }\n\nThe user provided the following feedback:\n<feedback>\n${userFeedback.text}\n</feedback>`,
          userFeedback.images
        ),
      ];
    }

    if (completed) {
      return [false, `Command executed.${result.length > 0 ? `\nOutput:\n${result}` : ""}`];
    } else {
      return [
        false,
        `Command is still running in the user's terminal.${
          result.length > 0 ? `\nHere's the output so far:\n${result}` : ""
        }\n\nYou will be updated on the terminal status and new output in the future.`,
      ];
    }
  }

  async writeToFileTool(relPath: string, newContent: string): Promise<[boolean, ToolResponse]> {
    const fileExists = await fileExistsAtPath(path.resolve(this.cwd, relPath));
    this.diffViewProvider.editType = fileExists ? "modify" : "create";

    // Pre-process content
    newContent = this.preprocessFileContent(newContent);

    const sharedMessageProps: ClineSayTool = {
      tool: fileExists ? "editedExistingFile" : "newFileCreated",
      path: getReadablePath(this.cwd, relPath),
    };

    try {
      if (!this.diffViewProvider.isEditing) {
        const partialMessage = JSON.stringify(sharedMessageProps);
        if (this.alwaysAllowWrite) {
          await this.webviewCommunicator.say("tool", partialMessage, undefined, true);
        } else {
          await this.webviewCommunicator.ask("tool", partialMessage, true);
        }
        await this.diffViewProvider.open(relPath);
      }

      await this.diffViewProvider.update(newContent, true);
      await delay(300);
      this.diffViewProvider.scrollToFirstDiff();
      showOmissionWarning(this.diffViewProvider.originalContent || "", newContent);

      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        content: fileExists ? undefined : newContent,
        diff: fileExists
          ? formatResponse.createPrettyPatch(
              relPath,
              this.diffViewProvider.originalContent,
              newContent
            )
          : undefined,
      } satisfies ClineSayTool);

      const didApprove = this.alwaysAllowWrite || 
        (await this.webviewCommunicator.ask("tool", completeMessage)).response === "yesButtonClicked";

      if (!didApprove) {
        await this.diffViewProvider.revertChanges();
        return [true, formatResponse.toolDenied()];
      }

      const { newProblemsMessage, userEdits, finalContent } = await this.diffViewProvider.saveChanges();
      this.didEditFile = true;

      if (userEdits) {
        await this.webviewCommunicator.say(
          "user_feedback_diff",
          JSON.stringify({
            tool: fileExists ? "editedExistingFile" : "newFileCreated",
            path: getReadablePath(this.cwd, relPath),
            diff: userEdits,
          } satisfies ClineSayTool)
        );

        return [
          false,
          `The user made the following updates to your content:\n\n${userEdits}\n\n` +
          `The updated content, which includes both your original modifications and the user's edits, has been successfully saved to ${relPath}. Here is the full, updated content of the file:\n\n` +
          `<final_file_content path="${relPath}">\n${finalContent}\n</final_file_content>\n\n` +
          `Please note:\n` +
          `1. You do not need to re-write the file with these changes, as they have already been applied.\n` +
          `2. Proceed with the task using this updated file content as the new baseline.\n` +
          `3. If the user's edits have addressed part of the task or changed the requirements, adjust your approach accordingly.` +
          `${newProblemsMessage}`
        ];
      }

      return [false, `The content was successfully saved to ${relPath}.${newProblemsMessage}`];
    } catch (error) {
      const errorMessage = `Error writing file: ${JSON.stringify(serializeError(error))}`;
      await this.webviewCommunicator.say(
        "error",
        `Error writing file:\n${error instanceof Error ? error.message : JSON.stringify(serializeError(error), null, 2)}`
      );
      await this.diffViewProvider.reset();
      return [false, formatResponse.toolError(errorMessage)];
    }
  }

  async readFileTool(relPath: string): Promise<[boolean, ToolResponse]> {
    const sharedMessageProps: ClineSayTool = {
      tool: "readFile",
      path: getReadablePath(this.cwd, relPath),
    };

    try {
      const absolutePath = path.resolve(this.cwd, relPath);
      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        content: absolutePath,
      } satisfies ClineSayTool);

      if (!this.alwaysAllowReadOnly) {
        const { response } = await this.webviewCommunicator.ask("tool", completeMessage);
        if (response !== "yesButtonClicked") {
          return [true, formatResponse.toolDenied()];
        }
      } else {
        await this.webviewCommunicator.say("tool", completeMessage);
      }

      const content = await extractTextFromFile(absolutePath);
      return [false, content];
    } catch (error) {
      const errorMessage = `Error reading file: ${JSON.stringify(serializeError(error))}`;
      await this.webviewCommunicator.say(
        "error",
        `Error reading file:\n${error instanceof Error ? error.message : JSON.stringify(serializeError(error), null, 2)}`
      );
      return [false, formatResponse.toolError(errorMessage)];
    }
  }

  async listFilesTool(relDirPath: string, recursive: boolean): Promise<[boolean, ToolResponse]> {
    const sharedMessageProps: ClineSayTool = {
      tool: !recursive ? "listFilesTopLevel" : "listFilesRecursive",
      path: getReadablePath(this.cwd, relDirPath),
    };

    try {
      const absolutePath = path.resolve(this.cwd, relDirPath);
      const [files, didHitLimit] = await listFiles(absolutePath, recursive, 200);
      const result = formatResponse.formatFilesList(absolutePath, files, didHitLimit);

      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        content: result,
      } satisfies ClineSayTool);

      if (!this.alwaysAllowReadOnly) {
        const { response } = await this.webviewCommunicator.ask("tool", completeMessage);
        if (response !== "yesButtonClicked") {
          return [true, formatResponse.toolDenied()];
        }
      } else {
        await this.webviewCommunicator.say("tool", completeMessage);
      }

      return [false, result];
    } catch (error) {
      const errorMessage = `Error listing files: ${JSON.stringify(serializeError(error))}`;
      await this.webviewCommunicator.say(
        "error",
        `Error listing files:\n${error instanceof Error ? error.message : JSON.stringify(serializeError(error), null, 2)}`
      );
      return [false, formatResponse.toolError(errorMessage)];
    }
  }

  async searchFilesTool(relDirPath: string, regex: string, filePattern?: string): Promise<[boolean, ToolResponse]> {
    const sharedMessageProps: ClineSayTool = {
      tool: "searchFiles",
      path: getReadablePath(this.cwd, relDirPath),
      regex,
      filePattern,
    };

    try {
      const absolutePath = path.resolve(this.cwd, relDirPath);
      const results = await regexSearchFiles(this.cwd, absolutePath, regex, filePattern);

      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        content: results,
      } satisfies ClineSayTool);

      if (!this.alwaysAllowReadOnly) {
        const { response } = await this.webviewCommunicator.ask("tool", completeMessage);
        if (response !== "yesButtonClicked") {
          return [true, formatResponse.toolDenied()];
        }
      } else {
        await this.webviewCommunicator.say("tool", completeMessage);
      }

      return [false, results];
    } catch (error) {
      const errorMessage = `Error searching files: ${JSON.stringify(serializeError(error))}`;
      await this.webviewCommunicator.say(
        "error",
        `Error searching files:\n${error instanceof Error ? error.message : JSON.stringify(serializeError(error), null, 2)}`
      );
      return [false, formatResponse.toolError(errorMessage)];
    }
  }

  async listCodeDefinitionsTool(relDirPath: string): Promise<[boolean, ToolResponse]> {
    const sharedMessageProps: ClineSayTool = {
      tool: "listCodeDefinitionNames",
      path: getReadablePath(this.cwd, relDirPath),
    };

    try {
      const absolutePath = path.resolve(this.cwd, relDirPath);
      const result = await parseSourceCodeForDefinitionsTopLevel(absolutePath);

      const completeMessage = JSON.stringify({
        ...sharedMessageProps,
        content: result,
      } satisfies ClineSayTool);

      if (!this.alwaysAllowReadOnly) {
        const { response } = await this.webviewCommunicator.ask("tool", completeMessage);
        if (response !== "yesButtonClicked") {
          return [true, formatResponse.toolDenied()];
        }
      } else {
        await this.webviewCommunicator.say("tool", completeMessage);
      }

      return [false, result];
    } catch (error) {
      const errorMessage = `Error parsing source code definitions: ${JSON.stringify(serializeError(error))}`;
      await this.webviewCommunicator.say(
        "error",
        `Error parsing source code definitions:\n${error instanceof Error ? error.message : JSON.stringify(serializeError(error), null, 2)}`
      );
      return [false, formatResponse.toolError(errorMessage)];
    }
  }

  async browserActionTool(
    action: BrowserAction,
    url?: string,
    coordinate?: string,
    text?: string
  ): Promise<[boolean, ToolResponse]> {
    if (!browserActions.includes(action)) {
      return [false, formatResponse.toolError("Invalid browser action")];
    }

    try {
      if (action === "launch") {
        if (!url) {
          return [false, formatResponse.toolError("URL is required for launch action")];
        }

        const { response } = await this.webviewCommunicator.ask("browser_action_launch", url);
        if (response !== "yesButtonClicked") {
          return [true, formatResponse.toolDenied()];
        }

        await this.webviewCommunicator.say("browser_action_result", "");
        await this.browserSession.launchBrowser();
        const result = await this.browserSession.navigateToUrl(url);
        await this.webviewCommunicator.say("browser_action_result", JSON.stringify(result));

        return [
          false,
          formatResponse.toolResult(
            `The browser action has been executed. The console logs and screenshot have been captured for your analysis.\n\nConsole logs:\n${
              result.logs || "(No new logs)"
            }\n\n(REMEMBER: if you need to proceed to using non-\`browser_action\` tools or launch a new browser, you MUST first close this browser.)`,
            result.screenshot ? [result.screenshot] : []
          ),
        ];
      }

      if (action === "close") {
        const result = await this.browserSession.closeBrowser();
        return [false, formatResponse.toolResult("The browser has been closed. You may now proceed to using other tools.")];
      }

      await this.webviewCommunicator.say(
        "browser_action",
        JSON.stringify({
          action,
          coordinate,
          text,
        })
      );

      let result;
      switch (action) {
        case "click":
          if (!coordinate) {
            return [false, formatResponse.toolError("Coordinate is required for click action")];
          }
          result = await this.browserSession.click(coordinate);
          break;
        case "type":
          if (!text) {
            return [false, formatResponse.toolError("Text is required for type action")];
          }
          result = await this.browserSession.type(text);
          break;
        case "scroll_down":
          result = await this.browserSession.scrollDown();
          break;
        case "scroll_up":
          result = await this.browserSession.scrollUp();
          break;
      }

      await this.webviewCommunicator.say("browser_action_result", JSON.stringify(result));

      return [
        false,
        formatResponse.toolResult(
          `The browser action has been executed. The console logs and screenshot have been captured for your analysis.\n\nConsole logs:\n${
            result.logs || "(No new logs)"
          }\n\n(REMEMBER: if you need to proceed to using non-\`browser_action\` tools or launch a new browser, you MUST first close this browser.)`,
          result.screenshot ? [result.screenshot] : []
        ),
      ];
    } catch (error) {
      await this.browserSession.closeBrowser();
      const errorMessage = `Error executing browser action: ${JSON.stringify(serializeError(error))}`;
      await this.webviewCommunicator.say(
        "error",
        `Error executing browser action:\n${error instanceof Error ? error.message : JSON.stringify(serializeError(error), null, 2)}`
      );
      return [false, formatResponse.toolError(errorMessage)];
    }
  }

  private preprocessFileContent(content: string): string {
    // Remove markdown codeblock markers if present
    if (content.startsWith("```")) {
      content = content.split("\n").slice(1).join("\n").trim();
    }
    if (content.endsWith("```")) {
      content = content.split("\n").slice(0, -1).join("\n").trim();
    }

    // Replace HTML entities
    return content
      .replace(/>/g, ">")
      .replace(/</g, "<")
      .replace(/"/g, '"');
  }

  getDidEditFile(): boolean {
    return this.didEditFile;
  }

  setDidEditFile(value: boolean): void {
    this.didEditFile = value;
  }
}
