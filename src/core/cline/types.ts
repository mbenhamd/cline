import { Anthropic } from "@anthropic-ai/sdk";

export interface TextContent {
  type: "text";
  content: string;
  partial?: boolean;
}

export interface ToolUse {
  type: "tool_use";
  name: string;
  params: Record<string, string>;
  partial?: boolean;
}

export type AssistantMessageContent = TextContent | ToolUse;

export type UserContent = Array<
  | Anthropic.Messages.TextBlockParam
  | Anthropic.Messages.ImageBlockParam
  | Anthropic.Messages.ToolUseBlockParam
  | Anthropic.Messages.ToolResultBlockParam
>;

export type ToolResponse = string | Array<Anthropic.Messages.TextBlockParam | Anthropic.Messages.ImageBlockParam>;

export interface ToolParamValues {
  command?: string;
  path?: string;
  content?: string;
  regex?: string;
  file_pattern?: string;
  recursive?: string;
  action?: string;
  url?: string;
  coordinate?: string;
  text?: string;
  question?: string;
  result?: string;
}

export type ToolParamName = keyof ToolParamValues;

export type ToolUseName = 
  | "execute_command"
  | "read_file"
  | "write_to_file"
  | "search_files"
  | "list_files"
  | "list_code_definition_names"
  | "browser_action"
  | "ask_followup_question"
  | "attempt_completion";

export interface FormatResponse {
  toolDenied: () => string;
  toolDeniedWithFeedback: (feedback?: string) => string;
  toolError: (error?: string) => string;
  noToolsUsed: () => string;
  tooManyMistakes: (feedback?: string) => string;
  imageBlocks: (images?: string[]) => Anthropic.Messages.ImageBlockParam[];
  formatContentBlock: (block: Anthropic.Messages.ContentBlock) => string;
  createPrettyPatch: (filename?: string, oldStr?: string, newStr?: string) => string;
  missingToolParameterError: (paramName: string) => string;
}

// Re-export types from Anthropic SDK for convenience
export type TextBlockParam = Anthropic.Messages.TextBlockParam;
export type ImageBlockParam = Anthropic.Messages.ImageBlockParam;
export type ToolUseBlockParam = Anthropic.Messages.ToolUseBlockParam;
export type ToolResultBlockParam = Anthropic.Messages.ToolResultBlockParam;
export type ContentBlock = Anthropic.Messages.ContentBlock;
export type Message = Anthropic.Messages.Message;
export type MessageParam = Anthropic.Messages.MessageParam;
export type Usage = Anthropic.Messages.Usage;
export type Model = Anthropic.Messages.Model;

// Additional type helpers
export type AnthropicBlock = TextBlockParam | ImageBlockParam | ToolUseBlockParam | ToolResultBlockParam;

export function isTextBlock(block: AnthropicBlock): block is TextBlockParam {
  return block.type === "text";
}

export function isToolUseBlock(block: AnthropicBlock): block is ToolUseBlockParam {
  return block.type === "tool_use";
}

export function isToolResultBlock(block: AnthropicBlock): block is ToolResultBlockParam {
  return block.type === "tool_result";
}

export function isImageBlock(block: AnthropicBlock): block is ImageBlockParam {
  return block.type === "image";
}

export function isTextContent(block: AssistantMessageContent): block is TextContent {
  return block.type === "text";
}

export function isToolUseContent(block: AssistantMessageContent): block is ToolUse {
  return block.type === "tool_use";
}
