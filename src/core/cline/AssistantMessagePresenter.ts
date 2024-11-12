import { Anthropic } from "@anthropic-ai/sdk";
import { AssistantMessageContent, TextBlockParam, ImageBlockParam, ToolUse, isTextContent, isToolUseContent } from "./types";
import { WebviewCommunicator } from "./WebviewCommunicator";
import { ToolExecutor } from "./ToolExecutor";
import { formatResponse } from "../prompts/responses";

export class AssistantMessagePresenter {
  private currentStreamingContentIndex: number = 0;
  private assistantMessageContent: AssistantMessageContent[] = [];
  private presentAssistantMessageLocked: boolean = false;
  private presentAssistantMessageHasPendingUpdates: boolean = false;
  private userMessageContent: (TextBlockParam | ImageBlockParam)[] = [];
  private userMessageContentReady: boolean = false;
  private didRejectTool: boolean = false;
  private didCompleteReadingStream: boolean = false;
  private webviewCommunicator: WebviewCommunicator;
  private toolExecutor: ToolExecutor;

  constructor(webviewCommunicator: WebviewCommunicator, toolExecutor: ToolExecutor) {
    this.webviewCommunicator = webviewCommunicator;
    this.toolExecutor = toolExecutor;
  }

  reset(): void {
    this.currentStreamingContentIndex = 0;
    this.assistantMessageContent = [];
    this.presentAssistantMessageLocked = false;
    this.presentAssistantMessageHasPendingUpdates = false;
    this.userMessageContent = [];
    this.userMessageContentReady = false;
    this.didRejectTool = false;
    this.didCompleteReadingStream = false;
  }

  async presentAssistantMessage(): Promise<void> {
    if (this.presentAssistantMessageLocked) {
      this.presentAssistantMessageHasPendingUpdates = true;
      return;
    }

    this.presentAssistantMessageLocked = true;
    this.presentAssistantMessageHasPendingUpdates = false;

    if (this.currentStreamingContentIndex >= this.assistantMessageContent.length) {
      if (this.didCompleteReadingStream) {
        this.userMessageContentReady = true;
      }
      this.presentAssistantMessageLocked = false;
      return;
    }

    const block = this.assistantMessageContent[this.currentStreamingContentIndex];
    if (!block) {
      this.presentAssistantMessageLocked = false;
      return;
    }

    try {
      if (isTextContent(block)) {
        if (!this.didRejectTool && block.content) {
          const content = this.preprocessTextContent(block.content);
          await this.webviewCommunicator.say("text", content, undefined, block.partial);
        }
      } else if (isToolUseContent(block)) {
        if (this.didRejectTool) {
          const toolDescription = this.getToolDescription(block);
          if (!block.partial) {
            this.userMessageContent.push({
              type: "text",
              text: `Skipping tool ${toolDescription} due to user rejecting a previous tool.`,
            });
          } else {
            this.userMessageContent.push({
              type: "text",
              text: `Tool ${toolDescription} was interrupted and not executed due to user rejecting a previous tool.`,
            });
          }
        } else {
          await this.handleToolUse(block);
        }
      }
    } finally {
      this.presentAssistantMessageLocked = false;
    }

    if (!block.partial || this.didRejectTool) {
      if (this.currentStreamingContentIndex === this.assistantMessageContent.length - 1) {
        this.userMessageContentReady = true;
      }

      this.currentStreamingContentIndex++;

      if (this.currentStreamingContentIndex < this.assistantMessageContent.length) {
        this.presentAssistantMessage();
        return;
      }
    }

    if (this.presentAssistantMessageHasPendingUpdates) {
      this.presentAssistantMessage();
    }
  }

  private preprocessTextContent(content: string): string {
    content = content.replace(/<thinking>\s?/g, "");
    content = content.replace(/\s?<\/thinking>/g, "");

    const lastOpenBracketIndex = content.lastIndexOf("<");
    if (lastOpenBracketIndex !== -1) {
      const possibleTag = content.slice(lastOpenBracketIndex);
      const hasCloseBracket = possibleTag.includes(">");
      if (!hasCloseBracket) {
        let tagContent: string;
        if (possibleTag.startsWith("</")) {
          tagContent = possibleTag.slice(2).trim();
        } else {
          tagContent = possibleTag.slice(1).trim();
        }
        const isLikelyTagName = /^[a-zA-Z_]+$/.test(tagContent);
        const isOpeningOrClosing = possibleTag === "<" || possibleTag === "</";
        if (isOpeningOrClosing || isLikelyTagName) {
          content = content.slice(0, lastOpenBracketIndex).trim();
        }
      }
    }

    return content;
  }

  private getToolDescription(block: ToolUse): string {
    switch (block.name) {
      case "execute_command":
        return `[${block.name} for '${block.params["command"]}']`;
      case "read_file":
      case "write_to_file":
      case "list_files":
      case "list_code_definition_names":
        return `[${block.name} for '${block.params["path"]}']`;
      case "search_files":
        return `[${block.name} for '${block.params["regex"]}'${
          block.params["file_pattern"] ? ` in '${block.params["file_pattern"]}']` : "]"
        }`;
      case "browser_action":
        return `[${block.name} for '${block.params["action"]}']`;
      case "ask_followup_question":
        return `[${block.name} for '${block.params["question"]}']`;
      case "attempt_completion":
        return `[${block.name}]`;
      default:
        return `[${block.name}]`;
    }
  }

  private async handleToolUse(block: ToolUse): Promise<void> {
    const toolDescription = this.getToolDescription(block);
    let didReject = false;
    let result: ToolResponse;

    try {
      switch (block.name) {
        case "execute_command":
          if (!block.params.command) {
            result = await this.webviewCommunicator.sayAndCreateMissingParamError(block.name, "command");
            break;
          }
          [didReject, result] = await this.toolExecutor.executeCommandTool(block.params.command);
          break;

        case "read_file":
          if (!block.params.path) {
            result = await this.webviewCommunicator.sayAndCreateMissingParamError(block.name, "path");
            break;
          }
          [didReject, result] = await this.toolExecutor.readFileTool(block.params.path);
          break;

        case "write_to_file":
          if (!block.params.path) {
            result = await this.webviewCommunicator.sayAndCreateMissingParamError(block.name, "path");
            break;
          }
          if (!block.params.content) {
            result = await this.webviewCommunicator.sayAndCreateMissingParamError(block.name, "content", block.params.path);
            break;
          }
          [didReject, result] = await this.toolExecutor.writeToFileTool(block.params.path, block.params.content);
          break;

        case "search_files":
          if (!block.params.path) {
            result = await this.webviewCommunicator.sayAndCreateMissingParamError(block.name, "path");
            break;
          }
          if (!block.params.regex) {
            result = await this.webviewCommunicator.sayAndCreateMissingParamError(block.name, "regex", block.params.path);
            break;
          }
          [didReject, result] = await this.toolExecutor.searchFilesTool(
            block.params.path,
            block.params.regex,
            block.params.file_pattern
          );
          break;

        case "list_files":
          if (!block.params.path) {
            result = await this.webviewCommunicator.sayAndCreateMissingParamError(block.name, "path");
            break;
          }
          [didReject, result] = await this.toolExecutor.listFilesTool(
            block.params.path,
            block.params.recursive === "true"
          );
          break;

        case "list_code_definition_names":
          if (!block.params.path) {
            result = await this.webviewCommunicator.sayAndCreateMissingParamError(block.name, "path");
            break;
          }
          [didReject, result] = await this.toolExecutor.listCodeDefinitionsTool(block.params.path);
          break;

        case "browser_action":
          if (!block.params.action) {
            result = await this.webviewCommunicator.sayAndCreateMissingParamError(block.name, "action");
            break;
          }
          [didReject, result] = await this.toolExecutor.browserActionTool(
            block.params.action as BrowserAction,
            block.params.url,
            block.params.coordinate,
            block.params.text
          );
          break;

        default:
          result = formatResponse.toolError(`Unknown tool: ${block.name}`);
          break;
      }

      if (didReject) {
        this.didRejectTool = true;
      }

      if (typeof result === "string") {
        this.userMessageContent.push({
          type: "text",
          text: result,
        });
      } else {
        this.userMessageContent.push(...result);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      await this.webviewCommunicator.say(
        "error",
        `Error executing ${toolDescription}:\n${errorMessage}`
      );
      this.userMessageContent.push({
        type: "text",
        text: formatResponse.toolError(`Error executing ${toolDescription}: ${errorMessage}`),
      });
    }
  }

  // Getters and setters
  getAssistantMessageContent(): AssistantMessageContent[] {
    return this.assistantMessageContent;
  }

  setAssistantMessageContent(content: AssistantMessageContent[]): void {
    this.assistantMessageContent = content;
  }

  getUserMessageContent(): (TextBlockParam | ImageBlockParam)[] {
    return this.userMessageContent;
  }

  addToUserMessageContent(content: TextBlockParam | ImageBlockParam): void {
    this.userMessageContent.push(content);
  }

  isUserMessageContentReady(): boolean {
    return this.userMessageContentReady;
  }

  setUserMessageContentReady(ready: boolean): void {
    this.userMessageContentReady = ready;
  }

  isDidRejectTool(): boolean {
    return this.didRejectTool;
  }

  setDidRejectTool(rejected: boolean): void {
    this.didRejectTool = rejected;
  }

  isDidCompleteReadingStream(): boolean {
    return this.didCompleteReadingStream;
  }

  setDidCompleteReadingStream(completed: boolean): void {
    this.didCompleteReadingStream = completed;
  }

  getCurrentStreamingContentIndex(): number {
    return this.currentStreamingContentIndex;
  }

  incrementStreamingContentIndex(): void {
    this.currentStreamingContentIndex++;
  }

  isPresentationLocked(): boolean {
    return this.presentAssistantMessageLocked;
  }

  setPresentationLocked(locked: boolean): void {
    this.presentAssistantMessageLocked = locked;
  }

  hasPendingUpdates(): boolean {
    return this.presentAssistantMessageHasPendingUpdates;
  }

  setPendingUpdates(hasPending: boolean): void {
    this.presentAssistantMessageHasPendingUpdates = hasPending;
  }
}
