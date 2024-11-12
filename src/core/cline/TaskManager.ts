import { ConversationManager } from "./ConversationManager";
import { WebviewCommunicator } from "./WebviewCommunicator";
import { Assistant } from "./Assistant";
import { ClineProvider } from "../webview/ClineProvider";
import { HistoryItem } from "../../shared/HistoryItem";
import { formatResponse } from "../prompts/responses";
import { findLastIndex } from "../../shared/array";
import { Anthropic } from "@anthropic-ai/sdk";
import { ClineApiReqInfo, ClineAsk, ClineMessage } from "../../shared/ExtensionMessage";
import { UserContent, TextBlockParam, ToolUseBlockParam, ToolResultBlockParam } from "./types";
import { findToolName } from "../../integrations/misc/export-markdown";
import path from "path";
import { ApiHandler } from "../../api";

export class TaskManager {
  private taskId: string;
  private conversationManager: ConversationManager;
  private webviewCommunicator: WebviewCommunicator;
  private assistant: Assistant;
  private providerRef: WeakRef<ClineProvider>;
  private historyItem?: HistoryItem;
  private consecutiveMistakeCount: number = 0;
  private cwd: string;
  private api: ApiHandler;
  private abort: boolean = false;

  constructor(
    taskId: string,
    conversationManager: ConversationManager,
    webviewCommunicator: WebviewCommunicator,
    assistant: Assistant,
    providerRef: WeakRef<ClineProvider>,
    cwd: string,
    api: ApiHandler,
    historyItem?: HistoryItem
  ) {
    this.taskId = taskId;
    this.conversationManager = conversationManager;
    this.webviewCommunicator = webviewCommunicator;
    this.assistant = assistant;
    this.providerRef = providerRef;
    this.cwd = cwd;
    this.api = api;
    this.historyItem = historyItem;
  }

  async startTask(task?: string, images?: string[]): Promise<void> {
    // Reset conversation state
    this.conversationManager.clineMessages = [];
    this.conversationManager.apiConversationHistory = [];
    await this.providerRef.deref()?.postStateToWebview();

    // Send initial task message
    await this.webviewCommunicator.say("text", task, images);

    // Create initial user content with task and images
    const imageBlocks: Anthropic.Messages.ImageBlockParam[] = formatResponse.imageBlocks(images);
    const initialContent: UserContent = [
      {
        type: "text",
        text: `<task>\n${task}\n</task>`,
      },
      ...imageBlocks,
    ];

    await this.initiateTaskLoop(initialContent);
  }

  async resumeTaskFromHistory(): Promise<void> {
    // Load and clean up messages
    const modifiedClineMessages = await this.conversationManager.getSavedClineMessages();

    // Remove any resume messages that may have been added before
    const lastRelevantMessageIndex = findLastIndex(
      modifiedClineMessages,
      (m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task")
    );

    if (lastRelevantMessageIndex !== -1) {
      modifiedClineMessages.splice(lastRelevantMessageIndex + 1);
    }

    // Clean up incomplete API requests
    const lastApiReqStartedIndex = findLastIndex(
      modifiedClineMessages,
      (m) => m.type === "say" && m.say === "api_req_started"
    );

    if (lastApiReqStartedIndex !== -1) {
      const lastApiReqStarted = modifiedClineMessages[lastApiReqStartedIndex];
      if (lastApiReqStarted?.text) {
        const { cost, cancelReason } = JSON.parse(lastApiReqStarted.text) as ClineApiReqInfo;
        if (cost === undefined && cancelReason === undefined) {
          modifiedClineMessages.splice(lastApiReqStartedIndex, 1);
        }
      }
    }

    await this.conversationManager.overwriteClineMessages(modifiedClineMessages);

    // Get last relevant message and determine ask type
    const lastClineMessage = modifiedClineMessages
      .slice()
      .reverse()
      .find((m) => !(m.ask === "resume_task" || m.ask === "resume_completed_task"));

    const askType: ClineAsk = lastClineMessage?.ask === "completion_result" 
      ? "resume_completed_task" 
      : "resume_task";

    // Get user response for resuming
    const { response, text, images } = await this.webviewCommunicator.ask(askType);
    if (response === "messageResponse" && text) {
      await this.webviewCommunicator.say("user_feedback", text, images);
    }

    // Process conversation history
    let existingApiConversationHistory = await this.conversationManager.getSavedApiConversationHistory();
    existingApiConversationHistory = this.convertToolBlocksToText(existingApiConversationHistory);

    // Process existing conversation
    const [modifiedOldUserContent, modifiedApiConversationHistory] = 
      this.processExistingConversation(existingApiConversationHistory);

    // Create new user content for resumption
    const newUserContent: UserContent = [...modifiedOldUserContent];

    // Add resumption message
    const agoText = this.getTimeAgoText(lastClineMessage?.ts ?? Date.now());
    const wasRecent = lastClineMessage?.ts 
      ? Date.now() - lastClineMessage.ts < 30_000 
      : false;

    newUserContent.push({
      type: "text",
      text: this.createResumptionMessage(agoText, wasRecent, text),
    });

    // Add images if provided
    if (images && images.length > 0) {
      newUserContent.push(...formatResponse.imageBlocks(images));
    }

    // Update conversation history and start task loop
    await this.conversationManager.overwriteApiConversationHistory(modifiedApiConversationHistory);
    await this.initiateTaskLoop(newUserContent);
  }

  private convertToolBlocksToText(history: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
    return history.map((message) => {
      if (!Array.isArray(message.content)) {
        return message;
      }

      const newContent = message.content.map((block) => {
        if (this.isToolUseBlock(block)) {
          const inputAsXml = Object.entries(block.input as Record<string, string>)
            .map(([key, value]) => `<${key}>\n${value}\n</${key}>`)
            .join("\n");

          return {
            type: "text",
            text: `<${block.name}>\n${inputAsXml}\n</${block.name}>`,
          } as TextBlockParam;
        }

        if (this.isToolResultBlock(block)) {
          const contentAsTextBlocks = Array.isArray(block.content)
            ? block.content.filter((item): item is Anthropic.Messages.TextBlockParam => item.type === "text")
            : [{ type: "text", text: block.content }];
          
          const textContent = contentAsTextBlocks.map((item) => item.text).join("\n\n");
          const toolName = findToolName(block.tool_use_id, history);

          return {
            type: "text",
            text: `[${toolName} Result]\n\n${textContent}`,
          } as TextBlockParam;
        }

        return block;
      });

      return { ...message, content: newContent };
    });
  }

  private isToolUseBlock(block: any): block is ToolUseBlockParam {
    return block?.type === "tool_use" && typeof block.name === "string";
  }

  private isToolResultBlock(block: any): block is ToolResultBlockParam {
    return block?.type === "tool_result" && typeof block.tool_use_id === "string";
  }

  private processExistingConversation(history: Anthropic.MessageParam[]): [UserContent, Anthropic.MessageParam[]] {
    if (history.length === 0) {
      throw new Error("Unexpected: No existing API conversation history");
    }

    const lastMessage = history[history.length - 1];

    // Handle assistant message
    if (lastMessage.role === "assistant") {
      const content = Array.isArray(lastMessage.content)
        ? lastMessage.content
        : [{ type: "text", text: lastMessage.content }];

      return [[], [...history]];
    }

    // Handle user message
    if (lastMessage.role === "user") {
      const existingUserContent = Array.isArray(lastMessage.content)
        ? lastMessage.content
        : [{ type: "text", text: lastMessage.content }];

      return [existingUserContent as UserContent, history.slice(0, -1)];
    }

    throw new Error("Unexpected message role in conversation history");
  }

  private getTimeAgoText(timestamp: number): string {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? "s" : ""} ago`;
    return "just now";
  }

  private createResumptionMessage(agoText: string, wasRecent: boolean, userFeedback?: string): string {
    let message = [
      `[TASK RESUMPTION] This task was interrupted ${agoText}.`,
      "It may or may not be complete, so please reassess the task context.",
      "Be aware that the project state may have changed since then.",
      `The current working directory is now '${this.cwd}'.`,
      "If the task has not been completed, retry the last step before interruption and proceed with completing the task.",
      "",
      "Note: If you previously attempted a tool use that the user did not provide a result for,",
      "you should assume the tool use was not successful and assess whether you should retry.",
      "If the last tool was a browser_action, the browser has been closed and you must launch a new browser if needed."
    ].join(" ");

    if (wasRecent) {
      message += [
        "",
        "",
        "IMPORTANT: If the last tool use was a write_to_file that was interrupted,",
        "the file was reverted back to its original state before the interrupted edit,",
        "and you do NOT need to re-read the file as you already have its up-to-date contents."
      ].join(" ");
    }

    if (userFeedback) {
      message += `\n\nNew instructions for task continuation:\n<user_message>\n${userFeedback}\n</user_message>`;
    }

    return message;
  }

  async initiateTaskLoop(userContent: UserContent): Promise<void> {
    let nextUserContent = userContent;
    let includeFileDetails = true;
    
    while (true) {
      if (this.abort) {
        break;
      }

      const didEndLoop = await this.assistant.handleTaskRequest(nextUserContent, includeFileDetails);
      includeFileDetails = false;

      if (didEndLoop) {
        break;
      }

      nextUserContent = [{ type: "text", text: formatResponse.noToolsUsed() }];
      this.consecutiveMistakeCount++;

      if (this.consecutiveMistakeCount >= 3) {
        const modelInfo = this.api.getModel();
        const message = modelInfo.id.includes("claude")
          ? [
              "This may indicate a failure in his thought process or inability to use a tool properly,",
              "which can be mitigated with some user guidance (e.g. \"Try breaking down the task into smaller steps\")."
            ].join(" ")
          : [
              "Cline uses complex prompts and iterative task execution that may be challenging for less capable models.",
              "For best results, it's recommended to use Claude 3.5 Sonnet for its advanced agentic coding capabilities."
            ].join(" ");

        const { response, text, images } = await this.webviewCommunicator.ask(
          "mistake_limit_reached",
          message
        );
        
        if (response === "messageResponse" && text) {
          nextUserContent = [
            { type: "text", text: formatResponse.tooManyMistakes(text) },
            ...formatResponse.imageBlocks(images),
          ];
          this.consecutiveMistakeCount = 0;
        }
      }
    }
  }

  abortTask(): void {
    this.abort = true;
    // Implement any additional logic needed to abort ongoing tasks, such as cancelling API requests or terminating processes.
  }
}
