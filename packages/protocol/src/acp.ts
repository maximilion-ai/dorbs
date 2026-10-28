// Vendored from T3 Code (https://github.com/pingdotgg/t3code) packages/effect-acp/src/_generated/schema-v1.gen.ts
// at commit 125b619, MIT (see THIRD_PARTY_LICENSES). Keeps only what these roots reach:
// InitializeRequest, InitializeResponse, NewSessionRequest, NewSessionResponse, LoadSessionRequest, LoadSessionResponse, PromptRequest, PromptResponse, CancelNotification, SessionNotification, RequestPermissionRequest, RequestPermissionResponse.
// Regenerate with `node packages/protocol/scripts/vendor-acp-v1.ts <t3code checkout> && pnpm fmt`.
import * as Schema from "effect/Schema";

export type SessionId = string;

export const SessionId = Schema.String.annotate({
  description:
    "A unique identifier for a conversation session between a client and agent.\n\nSessions maintain their own context, conversation history, and state,\nallowing multiple independent interactions with the same agent.\n\nSee protocol docs: [Session ID](https://agentclientprotocol.com/protocol/session-setup#session-id)",
  identifier: "SessionId",
});

export type LogoutCapabilities = { readonly _meta?: { readonly [x: string]: Schema.Json } | null };

export const LogoutCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Logout capabilities supported by the agent.\n\nSupplying `{}` means the agent supports the logout method.",
  identifier: "LogoutCapabilities",
});

export type PromptCapabilities = {
  readonly image?: boolean;
  readonly audio?: boolean;
  readonly embeddedContext?: boolean;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const PromptCapabilities = Schema.Struct({
  image: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Agent supports [`ContentBlock::Image`].",
      default: false,
    }),
  ),
  audio: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Agent supports [`ContentBlock::Audio`].",
      default: false,
    }),
  ),
  embeddedContext: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Agent supports embedded context in `session/prompt` requests.\n\nWhen enabled, the Client is allowed to include [`ContentBlock::Resource`]\nin prompt requests for pieces of context that are referenced in the message.",
      default: false,
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Prompt capabilities supported by the agent in `session/prompt` requests.\n\nBaseline agent functionality requires support for [`ContentBlock::Text`]\nand [`ContentBlock::ResourceLink`] in prompt requests.\n\nOther variants must be explicitly opted in to.\nCapabilities for different types of content in prompt requests.\n\nIndicates which content types beyond the baseline (text and resource links)\nthe agent can process.\n\nSee protocol docs: [Prompt Capabilities](https://agentclientprotocol.com/protocol/initialization#prompt-capabilities)",
  identifier: "PromptCapabilities",
});

export type McpCapabilities = {
  readonly http?: boolean;
  readonly sse?: boolean;
  readonly acp?: boolean;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const McpCapabilities = Schema.Struct({
  http: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Agent supports [`McpServer::Http`].", default: false }),
  ),
  sse: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Agent supports [`McpServer::Sse`].", default: false }),
  ),
  acp: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nAgent supports [`McpServer::Acp`].",
      default: false,
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "MCP capabilities supported by the agent",
  identifier: "McpCapabilities",
});

export type SessionListCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const SessionListCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Capabilities for the `session/list` method.\n\nSupplying `{}` means the agent supports listing sessions.",
  identifier: "SessionListCapabilities",
});

export type SessionDeleteCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const SessionDeleteCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Capabilities for the `session/delete` method.\n\nSupplying `{}` means the agent supports deleting sessions from `session/list`.",
  identifier: "SessionDeleteCapabilities",
});

export type SessionAdditionalDirectoriesCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const SessionAdditionalDirectoriesCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Capabilities for additional session directories support.\n\nSupplying `{}` means the agent supports the `additionalDirectories` field on\nsupported session lifecycle requests. Agents that also support\n`session/list` may return `SessionInfo.additionalDirectories` to report the\ncomplete ordered additional-root list associated with a listed session.",
  identifier: "SessionAdditionalDirectoriesCapabilities",
});

export type SessionForkCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const SessionForkCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nCapabilities for the `session/fork` method.\n\nSupplying `{}` means the agent supports forking sessions.",
  identifier: "SessionForkCapabilities",
});

export type SessionResumeCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const SessionResumeCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Capabilities for the `session/resume` method.\n\nSupplying `{}` means the agent supports resuming sessions.",
  identifier: "SessionResumeCapabilities",
});

export type SessionCloseCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const SessionCloseCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Capabilities for the `session/close` method.\n\nSupplying `{}` means the agent supports closing sessions.",
  identifier: "SessionCloseCapabilities",
});

export type ProvidersCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const ProvidersCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nProvider configuration capabilities supported by the agent.\n\nSupplying `{}` means the agent supports provider configuration methods.",
  identifier: "ProvidersCapabilities",
});

export type NesDocumentDidOpenCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesDocumentDidOpenCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Marker for `document/didOpen` capability support.",
  identifier: "NesDocumentDidOpenCapabilities",
});

export type TextDocumentSyncKind = "full" | "incremental";

export const TextDocumentSyncKind = Schema.Union([
  Schema.Literal("full").annotate({
    description: "Client sends the entire file content on each change.",
  }),
  Schema.Literal("incremental").annotate({ description: "Client sends only the changed ranges." }),
]).annotate({
  description: "How the agent wants document changes delivered.",
  identifier: "TextDocumentSyncKind",
});

export type NesDocumentDidCloseCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesDocumentDidCloseCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Marker for `document/didClose` capability support.",
  identifier: "NesDocumentDidCloseCapabilities",
});

export type NesDocumentDidSaveCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesDocumentDidSaveCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Marker for `document/didSave` capability support.",
  identifier: "NesDocumentDidSaveCapabilities",
});

export type NesDocumentDidFocusCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesDocumentDidFocusCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Marker for `document/didFocus` capability support.",
  identifier: "NesDocumentDidFocusCapabilities",
});

export type NesRecentFilesCapabilities = {
  readonly maxCount?: number | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesRecentFilesCapabilities = Schema.Struct({
  maxCount: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({
        description: "Maximum number of recent files the agent can use.",
        format: "uint32",
      })
        .check(Schema.isInt().annotate({ expected: "an integer" }))
        .check(
          Schema.isGreaterThanOrEqualTo(0).annotate({
            expected: "a value greater than or equal to 0",
          }),
        ),
      Schema.Null,
    ]),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Capabilities for recent files context.",
  identifier: "NesRecentFilesCapabilities",
});

export type NesRelatedSnippetsCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesRelatedSnippetsCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Capabilities for related snippets context.",
  identifier: "NesRelatedSnippetsCapabilities",
});

export type NesEditHistoryCapabilities = {
  readonly maxCount?: number | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesEditHistoryCapabilities = Schema.Struct({
  maxCount: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({
        description: "Maximum number of edit history entries the agent can use.",
        format: "uint32",
      })
        .check(Schema.isInt().annotate({ expected: "an integer" }))
        .check(
          Schema.isGreaterThanOrEqualTo(0).annotate({
            expected: "a value greater than or equal to 0",
          }),
        ),
      Schema.Null,
    ]),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Capabilities for edit history context.",
  identifier: "NesEditHistoryCapabilities",
});

export type NesUserActionsCapabilities = {
  readonly maxCount?: number | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesUserActionsCapabilities = Schema.Struct({
  maxCount: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({
        description: "Maximum number of user actions the agent can use.",
        format: "uint32",
      })
        .check(Schema.isInt().annotate({ expected: "an integer" }))
        .check(
          Schema.isGreaterThanOrEqualTo(0).annotate({
            expected: "a value greater than or equal to 0",
          }),
        ),
      Schema.Null,
    ]),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Capabilities for user actions context.",
  identifier: "NesUserActionsCapabilities",
});

export type NesOpenFilesCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesOpenFilesCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Capabilities for open files context.",
  identifier: "NesOpenFilesCapabilities",
});

export type NesDiagnosticsCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesDiagnosticsCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Capabilities for diagnostics context.",
  identifier: "NesDiagnosticsCapabilities",
});

export type PositionEncodingKind = "utf-16" | "utf-32" | "utf-8";

export const PositionEncodingKind = Schema.Union([
  Schema.Literal("utf-16").annotate({
    description: "Character offsets count UTF-16 code units. This is the default.",
  }),
  Schema.Literal("utf-32").annotate({
    description: "Character offsets count Unicode code points.",
  }),
  Schema.Literal("utf-8").annotate({
    description: "Character offsets count UTF-8 code units (bytes).",
  }),
]).annotate({
  description:
    "The encoding used for character offsets in positions.\n\nFollows the same conventions as LSP 3.17. The default is UTF-16.",
  identifier: "PositionEncodingKind",
});

export type Role = "assistant" | "user";

export const Role = Schema.Union([
  Schema.Literal("assistant").annotate({ description: "The assistant side of a conversation." }),
  Schema.Literal("user").annotate({ description: "The user side of a conversation." }),
]).annotate({
  description: "The sender or recipient of messages and data in a conversation.",
  identifier: "Role",
});

export type TextResourceContents = {
  readonly mimeType?: string | null;
  readonly text: string;
  readonly uri: string;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const TextResourceContents = Schema.Struct({
  mimeType: Schema.optionalKey(
    Schema.Union([
      Schema.String.annotate({ description: "MIME type describing the encoded media payload." }),
      Schema.Null,
    ]),
  ),
  text: Schema.String.annotate({ description: "Text payload carried by this content block." }),
  uri: Schema.String.annotate({
    description: "URI associated with this resource or media payload.",
  }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({ description: "Text-based resource contents.", identifier: "TextResourceContents" });

export type BlobResourceContents = {
  readonly blob: string;
  readonly mimeType?: string | null;
  readonly uri: string;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const BlobResourceContents = Schema.Struct({
  blob: Schema.String.annotate({
    description: "Base64-encoded bytes for a binary resource payload.",
  }),
  mimeType: Schema.optionalKey(
    Schema.Union([
      Schema.String.annotate({ description: "MIME type describing the encoded media payload." }),
      Schema.Null,
    ]),
  ),
  uri: Schema.String.annotate({
    description: "URI associated with this resource or media payload.",
  }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({ description: "Binary resource contents.", identifier: "BlobResourceContents" });

export type MessageId = string;

export const MessageId = Schema.String.annotate({
  description: "Unique identifier for a message within a session.",
  identifier: "MessageId",
});

export type ToolCallId = string;

export const ToolCallId = Schema.String.annotate({
  description: "Unique identifier for a tool call within a session.",
  identifier: "ToolCallId",
});

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export const ToolKind = Schema.Union([
  Schema.Literal("read").annotate({ description: "Reading files or data." }),
  Schema.Literal("edit").annotate({ description: "Modifying files or content." }),
  Schema.Literal("delete").annotate({ description: "Removing files or data." }),
  Schema.Literal("move").annotate({ description: "Moving or renaming files." }),
  Schema.Literal("search").annotate({ description: "Searching for information." }),
  Schema.Literal("execute").annotate({ description: "Running commands or code." }),
  Schema.Literal("think").annotate({ description: "Internal reasoning or planning." }),
  Schema.Literal("fetch").annotate({ description: "Retrieving external data." }),
  Schema.Literal("switch_mode").annotate({ description: "Switching the current session mode." }),
  Schema.Literal("other").annotate({ description: "Other tool types (default)." }),
]).annotate({
  description:
    "Categories of tools that can be invoked.\n\nTool kinds help clients choose appropriate icons and optimize how they\ndisplay tool execution progress.\n\nSee protocol docs: [Creating](https://agentclientprotocol.com/protocol/tool-calls#creating)",
  identifier: "ToolKind",
});

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export const ToolCallStatus = Schema.Union([
  Schema.Literal("pending").annotate({
    description:
      "The tool call hasn't started running yet because the input is either\nstreaming or we're awaiting approval.",
  }),
  Schema.Literal("in_progress").annotate({ description: "The tool call is currently running." }),
  Schema.Literal("completed").annotate({ description: "The tool call completed successfully." }),
  Schema.Literal("failed").annotate({ description: "The tool call failed with an error." }),
]).annotate({
  description:
    "Execution status of a tool call.\n\nTool calls progress through different statuses during their lifecycle.\n\nSee protocol docs: [Status](https://agentclientprotocol.com/protocol/tool-calls#status)",
  identifier: "ToolCallStatus",
});

export type TerminalId = string;

export const TerminalId = Schema.String.annotate({
  description: "Typed identifier used for terminal values on the wire.",
  identifier: "TerminalId",
});

export type ToolCallLocation = {
  readonly path: string;
  readonly line?: number | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const ToolCallLocation = Schema.Struct({
  path: Schema.String.annotate({
    description: "The absolute file path being accessed or modified.",
  }),
  line: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({
        description: "Optional line number within the file.",
        format: "uint32",
      })
        .check(Schema.isInt().annotate({ expected: "an integer" }))
        .check(
          Schema.isGreaterThanOrEqualTo(0).annotate({
            expected: "a value greater than or equal to 0",
          }),
        ),
      Schema.Null,
    ]),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    'A file location being accessed or modified by a tool.\n\nEnables clients to implement "follow-along" features that track\nwhich files the agent is working with in real-time.\n\nSee protocol docs: [Following the Agent](https://agentclientprotocol.com/protocol/tool-calls#following-the-agent)',
  identifier: "ToolCallLocation",
});

export type PlanEntryPriority = "high" | "medium" | "low";

export const PlanEntryPriority = Schema.Union([
  Schema.Literal("high").annotate({
    description: "High priority task - critical to the overall goal.",
  }),
  Schema.Literal("medium").annotate({
    description: "Medium priority task - important but not critical.",
  }),
  Schema.Literal("low").annotate({
    description: "Low priority task - nice to have but not essential.",
  }),
]).annotate({
  description:
    "Priority levels for plan entries.\n\nUsed to indicate the relative importance or urgency of different\ntasks in the execution plan.\nSee protocol docs: [Plan Entries](https://agentclientprotocol.com/protocol/agent-plan#plan-entries)",
  identifier: "PlanEntryPriority",
});

export type PlanEntryStatus = "pending" | "in_progress" | "completed";

export const PlanEntryStatus = Schema.Union([
  Schema.Literal("pending").annotate({ description: "The task has not started yet." }),
  Schema.Literal("in_progress").annotate({ description: "The task is currently being worked on." }),
  Schema.Literal("completed").annotate({
    description: "The task has been successfully completed.",
  }),
]).annotate({
  description:
    "Status of a plan entry in the execution flow.\n\nTracks the lifecycle of each task from planning through completion.\nSee protocol docs: [Plan Entries](https://agentclientprotocol.com/protocol/agent-plan#plan-entries)",
  identifier: "PlanEntryStatus",
});

export type PlanId = string;

export const PlanId = Schema.String.annotate({
  description:
    "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nUnique identifier for a plan within a session.",
  identifier: "PlanId",
});

export type UnstructuredCommandInput = {
  readonly hint: string;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const UnstructuredCommandInput = Schema.Struct({
  hint: Schema.String.annotate({
    description: "A hint to display when the input hasn't been provided yet",
  }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "All text that was typed after the command name is provided as input.",
  identifier: "UnstructuredCommandInput",
});

export type SessionModeId = string;

export const SessionModeId = Schema.String.annotate({
  description: "Unique identifier for a Session Mode.",
  identifier: "SessionModeId",
});

export type SessionConfigId = string;

export const SessionConfigId = Schema.String.annotate({
  description: "Unique identifier for a session configuration option.",
  identifier: "SessionConfigId",
});

export type SessionConfigOptionCategory =
  | "mode"
  | "model"
  | "model_config"
  | "thought_level"
  | string;

export const SessionConfigOptionCategory = Schema.Union([
  Schema.Literal("mode").annotate({ description: "Session mode selector." }),
  Schema.Literal("model").annotate({ description: "Model selector." }),
  Schema.Literal("model_config").annotate({
    description: "Model-related configuration parameter.",
  }),
  Schema.Literal("thought_level").annotate({ description: "Thought/reasoning level selector." }),
  Schema.String.annotate({ title: "other", description: "Unknown / uncategorized selector." }),
]).annotate({
  description:
    "Semantic category for a session configuration option.\n\nThis is intended to help Clients distinguish broadly common selectors (e.g. model selector vs\nsession mode selector vs thought/reasoning level) for UX purposes (keyboard shortcuts, icons,\nplacement). It MUST NOT be required for correctness. Clients MUST handle missing or unknown\ncategories gracefully.\n\nCategory names beginning with `_` are free for custom use, like other ACP extension methods.\nCategory names that do not begin with `_` are reserved for the ACP spec.",
  identifier: "SessionConfigOptionCategory",
});

export type SessionConfigValueId = string;

export const SessionConfigValueId = Schema.String.annotate({
  description: "Unique identifier for a session configuration option value.",
  identifier: "SessionConfigValueId",
});

export type SessionConfigGroupId = string;

export const SessionConfigGroupId = Schema.String.annotate({
  description: "Unique identifier for a session configuration option value group.",
  identifier: "SessionConfigGroupId",
});

export type Cost = {
  readonly amount: number;
  readonly currency: string;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const Cost = Schema.Struct({
  amount: Schema.Number.annotate({
    description: "Total cumulative cost for session.",
    format: "double",
  }).check(Schema.isFinite().annotate({ expected: "a finite number" })),
  currency: Schema.String.annotate({ description: 'ISO 4217 currency code (e.g., "USD", "EUR").' }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({ description: "Cost information for a session.", identifier: "Cost" });

export type CompactionId = string;

export const CompactionId = Schema.String.annotate({
  description:
    "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nUnique identifier for a context compaction within a session.",
  identifier: "CompactionId",
});

export type CompactionStatus = "in_progress" | "completed" | "failed" | "cancelled" | string;

export const CompactionStatus = Schema.Union([
  Schema.Literal("in_progress").annotate({
    description: "Compaction has started and has not finished.",
  }),
  Schema.Literal("completed").annotate({ description: "Compaction finished successfully." }),
  Schema.Literal("failed").annotate({ description: "Compaction finished unsuccessfully." }),
  Schema.Literal("cancelled").annotate({
    description: "Compaction was cancelled before it finished.",
  }),
  Schema.String.annotate({
    title: "other",
    description:
      "Custom or future compaction status.\n\nValues beginning with `_` are reserved for implementation-specific\nextensions. Other unknown values are reserved for future ACP statuses.",
  }),
]).annotate({
  description:
    "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nLifecycle state of a context compaction.",
  identifier: "CompactionStatus",
});

export type PermissionOptionId = string;

export const PermissionOptionId = Schema.String.annotate({
  description: "Unique identifier for a permission option.",
  identifier: "PermissionOptionId",
});

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export const PermissionOptionKind = Schema.Union([
  Schema.Literal("allow_once").annotate({ description: "Allow this operation only this time." }),
  Schema.Literal("allow_always").annotate({
    description: "Allow this operation and remember the choice.",
  }),
  Schema.Literal("reject_once").annotate({ description: "Reject this operation only this time." }),
  Schema.Literal("reject_always").annotate({
    description: "Reject this operation and remember the choice.",
  }),
]).annotate({
  description:
    "The type of permission option being presented to the user.\n\nHelps clients choose appropriate icons and UI treatment.",
  identifier: "PermissionOptionKind",
});

export type EnvVariable = {
  readonly name: string;
  readonly value: string;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const EnvVariable = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the environment variable." }),
  value: Schema.String.annotate({ description: "The value to set for the environment variable." }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "An environment variable to set when launching an MCP server.",
  identifier: "EnvVariable",
});

export type McpServerAcpId = string;

export const McpServerAcpId = Schema.String.annotate({
  description:
    "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nUnique identifier for an MCP server using the ACP transport.\n\nThe value is opaque and generated by the ACP component providing the MCP server. It is\nused by `mcp/connect` to route connection requests back to the component that declared the\nserver.",
  identifier: "McpServerAcpId",
});

export type ProtocolVersion = number;

export const ProtocolVersion = Schema.Number.annotate({
  description:
    "Protocol version identifier.\n\nThis version is only bumped for breaking changes.\nNon-breaking changes should be introduced via capabilities.",
  format: "uint16",
})
  .check(Schema.isInt().annotate({ expected: "an integer" }))
  .check(
    Schema.isGreaterThanOrEqualTo(0).annotate({ expected: "a value greater than or equal to 0" }),
  )
  .check(
    Schema.isLessThanOrEqualTo(65535).annotate({
      expected: "a value less than or equal to 65535",
      identifier: "ProtocolVersion",
    }),
  );

export type AuthMethodId = string;

export const AuthMethodId = Schema.String.annotate({
  description: "Typed identifier used for auth method values on the wire.",
  identifier: "AuthMethodId",
});

export type Implementation = {
  readonly name: string;
  readonly title?: string | null;
  readonly version: string;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const Implementation = Schema.Struct({
  name: Schema.String.annotate({
    description:
      "Intended for programmatic or logical use, but can be used as a display\nname fallback if title isn’t present.",
  }),
  title: Schema.optionalKey(
    Schema.Union([
      Schema.String.annotate({
        description:
          "Intended for UI and end-user contexts — optimized to be human-readable\nand easily understood.\n\nIf not provided, the name should be used for display.",
      }),
      Schema.Null,
    ]),
  ),
  version: Schema.String.annotate({
    description:
      'Version of the implementation. Can be displayed to the user or used\nfor debugging or metrics purposes. (e.g. "1.0.0").',
  }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Metadata about the implementation of the client or agent.\nDescribes the name and version of an ACP implementation, with an optional\ntitle for UI representation.",
  identifier: "Implementation",
});

export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";

export const StopReason = Schema.Union([
  Schema.Literal("end_turn").annotate({ description: "The turn ended successfully." }),
  Schema.Literal("max_tokens").annotate({
    description: "The turn ended because the agent reached the maximum number of tokens.",
  }),
  Schema.Literal("max_turn_requests").annotate({
    description:
      "The turn ended because the agent reached the maximum number of allowed\nagent requests between user turns.",
  }),
  Schema.Literal("refusal").annotate({
    description:
      "The turn ended because the agent refused to continue. The user prompt\nand everything that comes after it won't be included in the next\nprompt, so this should be reflected in the UI.",
  }),
  Schema.Literal("cancelled").annotate({
    description:
      "The turn was cancelled by the client via `session/cancel`.\n\nThis stop reason MUST be returned when the client sends a `session/cancel`\nnotification, even if the cancellation causes exceptions in underlying operations.\nAgents should catch these exceptions and return this semantically meaningful\nresponse to confirm successful cancellation.",
  }),
]).annotate({
  description:
    "Reasons why an agent stops processing a prompt turn.\n\nSee protocol docs: [Stop Reasons](https://agentclientprotocol.com/protocol/prompt-turn#stop-reasons)",
  identifier: "StopReason",
});

export type Usage = {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thoughtTokens?: number | null;
  readonly cachedReadTokens?: number | null;
  readonly cachedWriteTokens?: number | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const Usage = Schema.Struct({
  totalTokens: Schema.Number.annotate({
    description: "Sum of all token types across session.",
    format: "uint64",
  })
    .check(Schema.isInt().annotate({ expected: "an integer" }))
    .check(
      Schema.isGreaterThanOrEqualTo(0).annotate({ expected: "a value greater than or equal to 0" }),
    ),
  inputTokens: Schema.Number.annotate({
    description: "Total input tokens across all turns.",
    format: "uint64",
  })
    .check(Schema.isInt().annotate({ expected: "an integer" }))
    .check(
      Schema.isGreaterThanOrEqualTo(0).annotate({ expected: "a value greater than or equal to 0" }),
    ),
  outputTokens: Schema.Number.annotate({
    description: "Total output tokens across all turns.",
    format: "uint64",
  })
    .check(Schema.isInt().annotate({ expected: "an integer" }))
    .check(
      Schema.isGreaterThanOrEqualTo(0).annotate({ expected: "a value greater than or equal to 0" }),
    ),
  thoughtTokens: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ description: "Total thought/reasoning tokens", format: "uint64" })
        .check(Schema.isInt().annotate({ expected: "an integer" }))
        .check(
          Schema.isGreaterThanOrEqualTo(0).annotate({
            expected: "a value greater than or equal to 0",
          }),
        ),
      Schema.Null,
    ]),
  ),
  cachedReadTokens: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ description: "Total cache read tokens.", format: "uint64" })
        .check(Schema.isInt().annotate({ expected: "an integer" }))
        .check(
          Schema.isGreaterThanOrEqualTo(0).annotate({
            expected: "a value greater than or equal to 0",
          }),
        ),
      Schema.Null,
    ]),
  ),
  cachedWriteTokens: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({ description: "Total cache write tokens.", format: "uint64" })
        .check(Schema.isInt().annotate({ expected: "an integer" }))
        .check(
          Schema.isGreaterThanOrEqualTo(0).annotate({
            expected: "a value greater than or equal to 0",
          }),
        ),
      Schema.Null,
    ]),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nToken usage information for a prompt turn.",
  identifier: "Usage",
});

export type FileSystemCapabilities = {
  readonly readTextFile?: boolean;
  readonly writeTextFile?: boolean;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const FileSystemCapabilities = Schema.Struct({
  readTextFile: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Whether the Client supports `fs/read_text_file` requests.",
      default: false,
    }),
  ),
  writeTextFile: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Whether the Client supports `fs/write_text_file` requests.",
      default: false,
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "File system capabilities that a client may support.\n\nSee protocol docs: [FileSystem](https://agentclientprotocol.com/protocol/initialization#filesystem)",
  identifier: "FileSystemCapabilities",
});

export type CompactionCapabilities = { readonly [x: string]: never };

export const CompactionCapabilities = Schema.Record(Schema.String, Schema.Never).annotate({
  description:
    "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nClient support for ID-addressed context compaction updates.",
  identifier: "CompactionCapabilities",
});

export type BooleanConfigOptionCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const BooleanConfigOptionCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Capabilities for boolean session configuration options.\n\nSupplying `{}` means the client supports boolean session configuration options.",
  identifier: "BooleanConfigOptionCapabilities",
});

export type PlanCapabilities = { readonly _meta?: { readonly [x: string]: Schema.Json } | null };

export const PlanCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nCapabilities for receiving `plan_update` and `plan_removed` session updates.",
  identifier: "PlanCapabilities",
});

export type AuthCapabilities = {
  readonly terminal?: boolean;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const AuthCapabilities = Schema.Struct({
  terminal: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Whether the client supports `terminal` authentication methods.\n\nThe client should set this to `true` only when it can reproduce the\nconfigured agent invocation in an interactive terminal. When `true`, the\nagent may include `terminal` entries in its authentication methods.",
      default: false,
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Authentication capabilities supported by the client.\n\nAdvertised during initialization to inform the agent which authentication\nmethod types the client can handle. This governs opt-in types that require\nadditional client-side support.",
  identifier: "AuthCapabilities",
});

export type ElicitationFormCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const ElicitationFormCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nOptional. Omitted and `null` are equivalent and mean no metadata.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Form-based elicitation capabilities.\n\nSupplying `{}` means the client supports form-based elicitation.",
  identifier: "ElicitationFormCapabilities",
});

export type ElicitationUrlCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const ElicitationUrlCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nOptional. Omitted and `null` are equivalent and mean no metadata.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "URL-based elicitation capabilities.\n\nSupplying `{}` means the client supports URL-based elicitation.",
  identifier: "ElicitationUrlCapabilities",
});

export type NesJumpCapabilities = { readonly _meta?: { readonly [x: string]: Schema.Json } | null };

export const NesJumpCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Marker for jump suggestion support.",
  identifier: "NesJumpCapabilities",
});

export type NesRenameCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesRenameCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Marker for rename suggestion support.",
  identifier: "NesRenameCapabilities",
});

export type NesSearchAndReplaceCapabilities = {
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesSearchAndReplaceCapabilities = Schema.Struct({
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Marker for search and replace suggestion support.",
  identifier: "NesSearchAndReplaceCapabilities",
});

export type HttpHeader = {
  readonly name: string;
  readonly value: string;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const HttpHeader = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the HTTP header." }),
  value: Schema.String.annotate({ description: "The value to set for the HTTP header." }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "An HTTP header to set when making requests to the MCP server.",
  identifier: "HttpHeader",
});

export type CancelNotification = {
  readonly sessionId: SessionId;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const CancelNotification = Schema.Struct({
  sessionId: Schema.suspend((): Schema.Codec<SessionId> => SessionId).annotate({
    description: "The ID of the session to cancel operations for.",
  }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Notification to cancel ongoing operations for a session.\n\nSee protocol docs: [Cancellation](https://agentclientprotocol.com/protocol/prompt-turn#cancellation)",
  identifier: "CancelNotification",
});

export type AgentAuthCapabilities = {
  readonly logout?: LogoutCapabilities | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const AgentAuthCapabilities = Schema.Struct({
  logout: Schema.optionalKey(
    Schema.Union([LogoutCapabilities, Schema.Null]).annotate({
      description:
        "Whether the agent supports the logout method.\n\nOptional. Omitted or `null` both mean the agent does not advertise support.\nSupplying `{}` means the agent supports the logout method.",
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Authentication-related capabilities supported by the agent.",
  identifier: "AgentAuthCapabilities",
});

export type SessionCapabilities = {
  readonly list?: SessionListCapabilities | null;
  readonly delete?: SessionDeleteCapabilities | null;
  readonly additionalDirectories?: SessionAdditionalDirectoriesCapabilities | null;
  readonly fork?: SessionForkCapabilities | null;
  readonly resume?: SessionResumeCapabilities | null;
  readonly close?: SessionCloseCapabilities | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const SessionCapabilities = Schema.Struct({
  list: Schema.optionalKey(
    Schema.Union([SessionListCapabilities, Schema.Null]).annotate({
      description:
        "Whether the agent supports `session/list`.\n\nOptional. Omitted or `null` both mean the agent does not advertise support.\nSupplying `{}` means the agent supports listing sessions.",
    }),
  ),
  delete: Schema.optionalKey(
    Schema.Union([SessionDeleteCapabilities, Schema.Null]).annotate({
      description:
        "Whether the agent supports `session/delete`.\n\nOptional. Omitted or `null` both mean the agent does not advertise support.\nSupplying `{}` means the agent supports deleting sessions from `session/list`.",
    }),
  ),
  additionalDirectories: Schema.optionalKey(
    Schema.Union([SessionAdditionalDirectoriesCapabilities, Schema.Null]).annotate({
      description:
        "Whether the agent supports `additionalDirectories` on supported session lifecycle requests.\n\nOptional. Omitted or `null` both mean the agent does not advertise support.\nSupplying `{}` means the agent supports `additionalDirectories` on\nsupported session lifecycle requests.\n\nAgents that also support `session/list` may return\n`SessionInfo.additionalDirectories` to report the complete ordered\nadditional-root list associated with a listed session.",
    }),
  ),
  fork: Schema.optionalKey(
    Schema.Union([SessionForkCapabilities, Schema.Null]).annotate({
      description:
        "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nWhether the agent supports `session/fork`.\n\nOptional. Omitted or `null` both mean the agent does not advertise support.\nSupplying `{}` means the agent supports forking sessions.",
    }),
  ),
  resume: Schema.optionalKey(
    Schema.Union([SessionResumeCapabilities, Schema.Null]).annotate({
      description:
        "Whether the agent supports `session/resume`.\n\nOptional. Omitted or `null` both mean the agent does not advertise support.\nSupplying `{}` means the agent supports resuming sessions.",
    }),
  ),
  close: Schema.optionalKey(
    Schema.Union([SessionCloseCapabilities, Schema.Null]).annotate({
      description:
        "Whether the agent supports `session/close`.\n\nOptional. Omitted or `null` both mean the agent does not advertise support.\nSupplying `{}` means the agent supports closing sessions.",
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Session capabilities supported by the agent.\n\nAs a baseline, all Agents **MUST** support `session/new`, `session/prompt`, `session/cancel`, and `session/update`.\n\nOptionally, they **MAY** support other session methods and notifications by specifying additional capabilities.\n\nNote: `session/load` is still handled by the top-level `load_session` capability. This will be unified in future versions of the protocol.\n\nSee protocol docs: [Session Capabilities](https://agentclientprotocol.com/protocol/initialization#session-capabilities)",
  identifier: "SessionCapabilities",
});

export type NesDocumentDidChangeCapabilities = {
  readonly syncKind: TextDocumentSyncKind;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesDocumentDidChangeCapabilities = Schema.Struct({
  syncKind: Schema.suspend((): Schema.Codec<TextDocumentSyncKind> => TextDocumentSyncKind).annotate(
    { description: 'The sync kind the agent wants: `"full"` or `"incremental"`.' },
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Capabilities for `document/didChange` events.",
  identifier: "NesDocumentDidChangeCapabilities",
});

export type NesContextCapabilities = {
  readonly recentFiles?: NesRecentFilesCapabilities | null;
  readonly relatedSnippets?: NesRelatedSnippetsCapabilities | null;
  readonly editHistory?: NesEditHistoryCapabilities | null;
  readonly userActions?: NesUserActionsCapabilities | null;
  readonly openFiles?: NesOpenFilesCapabilities | null;
  readonly diagnostics?: NesDiagnosticsCapabilities | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesContextCapabilities = Schema.Struct({
  recentFiles: Schema.optionalKey(
    Schema.Union([NesRecentFilesCapabilities, Schema.Null]).annotate({
      description: "Whether the agent wants recent files context.",
    }),
  ),
  relatedSnippets: Schema.optionalKey(
    Schema.Union([NesRelatedSnippetsCapabilities, Schema.Null]).annotate({
      description: "Whether the agent wants related snippets context.",
    }),
  ),
  editHistory: Schema.optionalKey(
    Schema.Union([NesEditHistoryCapabilities, Schema.Null]).annotate({
      description: "Whether the agent wants edit history context.",
    }),
  ),
  userActions: Schema.optionalKey(
    Schema.Union([NesUserActionsCapabilities, Schema.Null]).annotate({
      description: "Whether the agent wants user actions context.",
    }),
  ),
  openFiles: Schema.optionalKey(
    Schema.Union([NesOpenFilesCapabilities, Schema.Null]).annotate({
      description: "Whether the agent wants open files context.",
    }),
  ),
  diagnostics: Schema.optionalKey(
    Schema.Union([NesDiagnosticsCapabilities, Schema.Null]).annotate({
      description: "Whether the agent wants diagnostics context.",
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Context capabilities the agent wants attached to each suggestion request.",
  identifier: "NesContextCapabilities",
});

export type Annotations = {
  readonly audience?: ReadonlyArray<Role> | null;
  readonly lastModified?: string | null;
  readonly priority?: number | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const Annotations = Schema.Struct({
  audience: Schema.optionalKey(
    Schema.Union([
      Schema.Array(Role).annotate({
        description: "Intended recipients for this content, such as the user or assistant.",
      }),
      Schema.Null,
    ]),
  ),
  lastModified: Schema.optionalKey(
    Schema.Union([
      Schema.String.annotate({
        description: "Timestamp indicating when the underlying resource was last modified.",
      }),
      Schema.Null,
    ]),
  ),
  priority: Schema.optionalKey(
    Schema.Union([
      Schema.Number.annotate({
        description: "Relative importance of this content when clients choose what to surface.",
        format: "double",
      }).check(Schema.isFinite().annotate({ expected: "a finite number" })),
      Schema.Null,
    ]),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Optional annotations for the client. The client can use annotations to inform how objects are used or displayed",
  identifier: "Annotations",
});

export type EmbeddedResourceResource = TextResourceContents | BlobResourceContents;

export const EmbeddedResourceResource = Schema.Union([
  Schema.suspend((): Schema.Codec<TextResourceContents> => TextResourceContents).annotate({
    title: "TextResourceContents",
    description: "Text resource contents embedded directly in the message.",
  }),
  Schema.suspend((): Schema.Codec<BlobResourceContents> => BlobResourceContents).annotate({
    title: "BlobResourceContents",
    description: "Binary resource contents embedded directly in the message.",
  }),
]).annotate({
  description: "Resource content that can be embedded in a message.",
  identifier: "EmbeddedResourceResource",
});

export type PlanEntry = {
  readonly content: string;
  readonly priority: PlanEntryPriority;
  readonly status: PlanEntryStatus;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const PlanEntry = Schema.Struct({
  content: Schema.String.annotate({
    description: "Human-readable description of what this task aims to accomplish.",
  }),
  priority: Schema.suspend((): Schema.Codec<PlanEntryPriority> => PlanEntryPriority).annotate({
    description:
      "The relative importance of this task.\nUsed to indicate which tasks are most critical to the overall goal.",
  }),
  status: Schema.suspend((): Schema.Codec<PlanEntryStatus> => PlanEntryStatus).annotate({
    description: "Current execution status of this task.",
  }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "A single entry in the execution plan.\n\nRepresents a task or goal that the assistant intends to accomplish\nas part of fulfilling the user's request.\nSee protocol docs: [Plan Entries](https://agentclientprotocol.com/protocol/agent-plan#plan-entries)",
  identifier: "PlanEntry",
});

export type AvailableCommandInput = UnstructuredCommandInput;

export const AvailableCommandInput = Schema.Union([
  Schema.suspend((): Schema.Codec<UnstructuredCommandInput> => UnstructuredCommandInput).annotate({
    title: "unstructured",
    description: "All text that was typed after the command name is provided as input.",
  }),
]).annotate({
  description: "The input specification for a command.",
  identifier: "AvailableCommandInput",
});

export type SessionMode = {
  readonly id: SessionModeId;
  readonly name: string;
  readonly description?: string | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const SessionMode = Schema.Struct({
  id: Schema.suspend((): Schema.Codec<SessionModeId> => SessionModeId).annotate({
    description: "Stable identifier used to refer to this protocol object in later messages.",
  }),
  name: Schema.String.annotate({
    description: "Human-readable name shown for this protocol object.",
  }),
  description: Schema.optionalKey(
    Schema.Union([
      Schema.String.annotate({
        description: "Optional human-readable details shown with this protocol object.",
      }),
      Schema.Null,
    ]),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "A mode the agent can operate in.\n\nSee protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes)",
  identifier: "SessionMode",
});

export type SessionConfigSelectOption = {
  readonly value: SessionConfigValueId;
  readonly name: string;
  readonly description?: string | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const SessionConfigSelectOption = Schema.Struct({
  value: Schema.suspend((): Schema.Codec<SessionConfigValueId> => SessionConfigValueId).annotate({
    description: "Unique identifier for this option value.",
  }),
  name: Schema.String.annotate({ description: "Human-readable label for this option value." }),
  description: Schema.optionalKey(
    Schema.Union([
      Schema.String.annotate({ description: "Optional description for this option value." }),
      Schema.Null,
    ]),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "A possible value for a session configuration option.",
  identifier: "SessionConfigSelectOption",
});

export type RequestPermissionOutcome =
  | { readonly outcome: "cancelled" }
  | {
      readonly outcome: "selected";
      readonly optionId: PermissionOptionId;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    };

export const RequestPermissionOutcome = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("cancelled") }).annotate({
    description:
      "The prompt turn was cancelled before the user responded.\n\nWhen a client sends a `session/cancel` notification to cancel an ongoing\nprompt turn, it MUST respond to all pending `session/request_permission`\nrequests with this `Cancelled` outcome.\n\nSee protocol docs: [Cancellation](https://agentclientprotocol.com/protocol/prompt-turn#cancellation)",
  }),
  Schema.Struct({
    outcome: Schema.Literal("selected"),
    optionId: Schema.suspend((): Schema.Codec<PermissionOptionId> => PermissionOptionId).annotate({
      description: "The ID of the option the user selected.",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({ description: "The user selected one of the provided options." }),
]).annotate({
  description: "The outcome of a permission request.",
  identifier: "RequestPermissionOutcome",
});

export type PermissionOption = {
  readonly optionId: PermissionOptionId;
  readonly name: string;
  readonly kind: PermissionOptionKind;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const PermissionOption = Schema.Struct({
  optionId: Schema.suspend((): Schema.Codec<PermissionOptionId> => PermissionOptionId).annotate({
    description: "Unique identifier for this permission option.",
  }),
  name: Schema.String.annotate({ description: "Human-readable label to display to the user." }),
  kind: Schema.suspend((): Schema.Codec<PermissionOptionKind> => PermissionOptionKind).annotate({
    description: "Hint about the nature of this permission option.",
  }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "An option presented to the user when requesting permission.",
  identifier: "PermissionOption",
});

export type McpServerStdio = {
  readonly name: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: ReadonlyArray<EnvVariable>;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const McpServerStdio = Schema.Struct({
  name: Schema.String.annotate({ description: "Human-readable name identifying this MCP server." }),
  command: Schema.String.annotate({ description: "Absolute path to the MCP server executable." }),
  args: Schema.Array(Schema.String).annotate({
    description: "Command-line arguments to pass to the MCP server.",
  }),
  env: Schema.Array(EnvVariable).annotate({
    description: "Environment variables to set when launching the MCP server.",
  }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Stdio transport configuration for MCP.",
  identifier: "McpServerStdio",
});

export type AuthMethodAgent = {
  readonly id: AuthMethodId;
  readonly name: string;
  readonly description?: string | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const AuthMethodAgent = Schema.Struct({
  id: Schema.suspend((): Schema.Codec<AuthMethodId> => AuthMethodId).annotate({
    description: "Unique identifier for this authentication method.",
  }),
  name: Schema.String.annotate({
    description: "Human-readable name of the authentication method.",
  }),
  description: Schema.optionalKey(
    Schema.Union([
      Schema.String.annotate({
        description:
          "Optional description providing more details about this authentication method.",
      }),
      Schema.Null,
    ]),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Agent handles authentication itself through `authenticate`.\n\nThis is the default authentication method type.",
  identifier: "AuthMethodAgent",
});

export type PromptResponse = {
  readonly stopReason: StopReason;
  readonly usage?: Usage | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const PromptResponse = Schema.Struct({
  stopReason: Schema.suspend((): Schema.Codec<StopReason> => StopReason).annotate({
    description: "Indicates why the agent stopped processing the turn.",
  }),
  usage: Schema.optionalKey(
    Schema.Union([Usage, Schema.Null]).annotate({
      description:
        "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nToken usage for this turn (optional).",
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Response from processing a user prompt.\n\nSee protocol docs: [Check for Completion](https://agentclientprotocol.com/protocol/prompt-turn#4-check-for-completion)",
  identifier: "PromptResponse",
});

export type SessionConfigOptionsCapabilities = {
  readonly boolean?: BooleanConfigOptionCapabilities | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const SessionConfigOptionsCapabilities = Schema.Struct({
  boolean: Schema.optionalKey(
    Schema.Union([BooleanConfigOptionCapabilities, Schema.Null]).annotate({
      description:
        'Whether the client supports boolean session configuration options.\n\nOptional. Omitted or `null` both mean the client does not advertise support.\nSupplying `{}` means agents may include `type: "boolean"` entries in\n`configOptions`, and the client may send `session/set_config_option`\nrequests with `type: "boolean"` and a boolean `value`.',
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Session configuration option capabilities supported by the client.",
  identifier: "SessionConfigOptionsCapabilities",
});

export type ElicitationCapabilities = {
  readonly form?: ElicitationFormCapabilities | null;
  readonly url?: ElicitationUrlCapabilities | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const ElicitationCapabilities = Schema.Struct({
  form: Schema.optionalKey(
    Schema.Union([ElicitationFormCapabilities, Schema.Null]).annotate({
      description:
        "Whether the client supports form-based elicitation.\n\nOptional. Omitted and `null` are equivalent and mean form support is not advertised.\nSupplying `{}` explicitly advertises form support.",
    }),
  ),
  url: Schema.optionalKey(
    Schema.Union([ElicitationUrlCapabilities, Schema.Null]).annotate({
      description:
        "Whether the client supports URL-based elicitation.\n\nOptional. Omitted or `null` both mean the client does not advertise support.\nSupplying `{}` means the client supports URL-based elicitation.",
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nOptional. Omitted and `null` are equivalent and mean no metadata.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Elicitation capabilities supported by the client.",
  identifier: "ElicitationCapabilities",
});

export type ClientNesCapabilities = {
  readonly jump?: NesJumpCapabilities | null;
  readonly rename?: NesRenameCapabilities | null;
  readonly searchAndReplace?: NesSearchAndReplaceCapabilities | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const ClientNesCapabilities = Schema.Struct({
  jump: Schema.optionalKey(
    Schema.Union([NesJumpCapabilities, Schema.Null]).annotate({
      description: "Whether the client supports the `jump` suggestion kind.",
    }),
  ),
  rename: Schema.optionalKey(
    Schema.Union([NesRenameCapabilities, Schema.Null]).annotate({
      description: "Whether the client supports the `rename` suggestion kind.",
    }),
  ),
  searchAndReplace: Schema.optionalKey(
    Schema.Union([NesSearchAndReplaceCapabilities, Schema.Null]).annotate({
      description: "Whether the client supports the `searchAndReplace` suggestion kind.",
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "NES capabilities advertised by the client during initialization.",
  identifier: "ClientNesCapabilities",
});

export type NesDocumentEventCapabilities = {
  readonly didOpen?: NesDocumentDidOpenCapabilities | null;
  readonly didChange?: NesDocumentDidChangeCapabilities | null;
  readonly didClose?: NesDocumentDidCloseCapabilities | null;
  readonly didSave?: NesDocumentDidSaveCapabilities | null;
  readonly didFocus?: NesDocumentDidFocusCapabilities | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesDocumentEventCapabilities = Schema.Struct({
  didOpen: Schema.optionalKey(
    Schema.Union([NesDocumentDidOpenCapabilities, Schema.Null]).annotate({
      description: "Whether the agent wants `document/didOpen` events.",
    }),
  ),
  didChange: Schema.optionalKey(
    Schema.Union([NesDocumentDidChangeCapabilities, Schema.Null]).annotate({
      description: "Whether the agent wants `document/didChange` events, and the sync kind.",
    }),
  ),
  didClose: Schema.optionalKey(
    Schema.Union([NesDocumentDidCloseCapabilities, Schema.Null]).annotate({
      description: "Whether the agent wants `document/didClose` events.",
    }),
  ),
  didSave: Schema.optionalKey(
    Schema.Union([NesDocumentDidSaveCapabilities, Schema.Null]).annotate({
      description: "Whether the agent wants `document/didSave` events.",
    }),
  ),
  didFocus: Schema.optionalKey(
    Schema.Union([NesDocumentDidFocusCapabilities, Schema.Null]).annotate({
      description: "Whether the agent wants `document/didFocus` events.",
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Document event capabilities the agent wants to receive.",
  identifier: "NesDocumentEventCapabilities",
});

export type ContentBlock =
  | {
      readonly type: "text";
      readonly annotations?: Annotations | null;
      readonly text: string;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly type: "image";
      readonly annotations?: Annotations | null;
      readonly data: string;
      readonly mimeType: string;
      readonly uri?: string | null;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly type: "audio";
      readonly annotations?: Annotations | null;
      readonly data: string;
      readonly mimeType: string;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly type: "resource_link";
      readonly annotations?: Annotations | null;
      readonly description?: string | null;
      readonly mimeType?: string | null;
      readonly name: string;
      readonly size?: number | null;
      readonly title?: string | null;
      readonly uri: string;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly type: "resource";
      readonly annotations?: Annotations | null;
      readonly resource: EmbeddedResourceResource;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    };

export const ContentBlock = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("text"),
    annotations: Schema.optionalKey(
      Schema.Union([Annotations, Schema.Null]).annotate({
        description:
          "Optional annotations that help clients decide how to display or route this content.",
      }),
    ),
    text: Schema.String.annotate({ description: "Text payload carried by this content block." }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({ description: "Text provided to or from an LLM." }),
  Schema.Struct({
    type: Schema.Literal("image"),
    annotations: Schema.optionalKey(
      Schema.Union([Annotations, Schema.Null]).annotate({
        description:
          "Optional annotations that help clients decide how to display or route this content.",
      }),
    ),
    data: Schema.String.annotate({ description: "Base64-encoded media payload." }),
    mimeType: Schema.String.annotate({
      description: "MIME type describing the encoded media payload.",
    }),
    uri: Schema.optionalKey(
      Schema.Union([
        Schema.String.annotate({
          description: "URI associated with this resource or media payload.",
        }),
        Schema.Null,
      ]),
    ),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({ description: "An image provided to or from an LLM." }),
  Schema.Struct({
    type: Schema.Literal("audio"),
    annotations: Schema.optionalKey(
      Schema.Union([Annotations, Schema.Null]).annotate({
        description:
          "Optional annotations that help clients decide how to display or route this content.",
      }),
    ),
    data: Schema.String.annotate({ description: "Base64-encoded media payload." }),
    mimeType: Schema.String.annotate({
      description: "MIME type describing the encoded media payload.",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({ description: "Audio provided to or from an LLM." }),
  Schema.Struct({
    type: Schema.Literal("resource_link"),
    annotations: Schema.optionalKey(
      Schema.Union([Annotations, Schema.Null]).annotate({
        description:
          "Optional annotations that help clients decide how to display or route this content.",
      }),
    ),
    description: Schema.optionalKey(
      Schema.Union([
        Schema.String.annotate({
          description: "Optional human-readable details shown with this protocol object.",
        }),
        Schema.Null,
      ]),
    ),
    mimeType: Schema.optionalKey(
      Schema.Union([
        Schema.String.annotate({ description: "MIME type describing the encoded media payload." }),
        Schema.Null,
      ]),
    ),
    name: Schema.String.annotate({
      description: "Human-readable name shown for this protocol object.",
    }),
    size: Schema.optionalKey(
      Schema.Union([
        Schema.Number.annotate({
          description: "Optional size of the linked resource in bytes, if known.",
          format: "int64",
        }).check(Schema.isInt().annotate({ expected: "an integer" })),
        Schema.Null,
      ]),
    ),
    title: Schema.optionalKey(
      Schema.Union([
        Schema.String.annotate({ description: "Optional display title for end-user UI." }),
        Schema.Null,
      ]),
    ),
    uri: Schema.String.annotate({
      description: "URI associated with this resource or media payload.",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "A resource that the server is capable of reading, included in a prompt or tool call result.",
  }),
  Schema.Struct({
    type: Schema.Literal("resource"),
    annotations: Schema.optionalKey(
      Schema.Union([Annotations, Schema.Null]).annotate({
        description:
          "Optional annotations that help clients decide how to display or route this content.",
      }),
    ),
    resource: Schema.suspend(
      (): Schema.Codec<EmbeddedResourceResource> => EmbeddedResourceResource,
    ).annotate({ description: "Embedded resource payload, either text or binary data." }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description: "The contents of a resource, embedded into a prompt or tool call result.",
  }),
]).annotate({
  description:
    "Content blocks represent displayable information in the Agent Client Protocol.\n\nThey provide a structured way to handle various types of user-facing content—whether\nit's text from language models, images for analysis, or embedded resources for context.\n\nContent blocks appear in:\n- User prompts sent via `session/prompt`\n- Language model output streamed through `session/update` notifications\n- Progress updates and results from tool calls\n\nThis structure is compatible with the Model Context Protocol (MCP), enabling\nagents to seamlessly forward content from MCP tool outputs without transformation.\n\nSee protocol docs: [Content](https://agentclientprotocol.com/protocol/content)",
  identifier: "ContentBlock",
});

export type PlanUpdateContent =
  | {
      readonly type: "items";
      readonly planId: PlanId;
      readonly entries: ReadonlyArray<PlanEntry>;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly type: "file";
      readonly planId: PlanId;
      readonly uri: string;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly type: "markdown";
      readonly planId: PlanId;
      readonly content: string;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    };

export const PlanUpdateContent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("items"),
    planId: Schema.suspend((): Schema.Codec<PlanId> => PlanId).annotate({
      description: "The plan ID to update.",
    }),
    entries: Schema.Array(PlanEntry).annotate({
      description:
        "The list of tasks to be accomplished.\n\nWhen updating an item-based plan, the agent must send a complete list of all entries\nwith their current status. The client replaces that plan with each update.",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nA plan represented as structured entries.",
  }),
  Schema.Struct({
    type: Schema.Literal("file"),
    planId: Schema.suspend((): Schema.Codec<PlanId> => PlanId).annotate({
      description: "The plan ID to update.",
    }),
    uri: Schema.String.annotate({ description: "The URI of the file containing the plan." }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nA plan represented by a file URI.",
  }),
  Schema.Struct({
    type: Schema.Literal("markdown"),
    planId: Schema.suspend((): Schema.Codec<PlanId> => PlanId).annotate({
      description: "The plan ID to update.",
    }),
    content: Schema.String.annotate({ description: "Markdown content for the plan." }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nA plan represented as raw markdown content.",
  }),
]).annotate({
  description:
    "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nUpdated content for a plan.",
  identifier: "PlanUpdateContent",
});

export type AvailableCommand = {
  readonly name: string;
  readonly description: string;
  readonly input?: AvailableCommandInput | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const AvailableCommand = Schema.Struct({
  name: Schema.String.annotate({
    description: "Command name (e.g., `create_plan`, `research_codebase`).",
  }),
  description: Schema.String.annotate({
    description: "Human-readable description of what the command does.",
  }),
  input: Schema.optionalKey(
    Schema.Union([AvailableCommandInput, Schema.Null]).annotate({
      description: "Input for the command if required",
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({ description: "Information about a command.", identifier: "AvailableCommand" });

export type SessionModeState = {
  readonly currentModeId: SessionModeId;
  readonly availableModes: ReadonlyArray<SessionMode>;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const SessionModeState = Schema.Struct({
  currentModeId: Schema.suspend((): Schema.Codec<SessionModeId> => SessionModeId).annotate({
    description: "The current mode the Agent is in.",
  }),
  availableModes: Schema.Array(SessionMode).annotate({
    description: "The set of modes that the Agent can operate in",
  }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "The set of modes and the one currently active.",
  identifier: "SessionModeState",
});

export type SessionConfigSelectGroup = {
  readonly group: SessionConfigGroupId;
  readonly name: string;
  readonly options: ReadonlyArray<SessionConfigSelectOption>;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const SessionConfigSelectGroup = Schema.Struct({
  group: Schema.suspend((): Schema.Codec<SessionConfigGroupId> => SessionConfigGroupId).annotate({
    description: "Unique identifier for this group.",
  }),
  name: Schema.String.annotate({ description: "Human-readable label for this group." }),
  options: Schema.Array(SessionConfigSelectOption).annotate({
    description: "The set of option values in this group.",
  }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "A group of possible values for a session configuration option.",
  identifier: "SessionConfigSelectGroup",
});

export type RequestPermissionResponse = {
  readonly outcome: RequestPermissionOutcome;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const RequestPermissionResponse = Schema.Struct({
  outcome: Schema.suspend(
    (): Schema.Codec<RequestPermissionOutcome> => RequestPermissionOutcome,
  ).annotate({ description: "The user's decision on the permission request." }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Response to a permission request.",
  identifier: "RequestPermissionResponse",
});

export type McpServer =
  | {
      readonly type: "http";
      readonly name: string;
      readonly url: string;
      readonly headers: ReadonlyArray<HttpHeader>;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly type: "sse";
      readonly name: string;
      readonly url: string;
      readonly headers: ReadonlyArray<HttpHeader>;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly type: "acp";
      readonly name: string;
      readonly serverId: McpServerAcpId;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | McpServerStdio;

export const McpServer = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("http"),
    name: Schema.String.annotate({
      description: "Human-readable name identifying this MCP server.",
    }),
    url: Schema.String.annotate({ description: "URL to the MCP server." }),
    headers: Schema.Array(HttpHeader).annotate({
      description: "HTTP headers to set when making requests to the MCP server.",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({ description: "HTTP transport configuration for MCP." }),
  Schema.Struct({
    type: Schema.Literal("sse"),
    name: Schema.String.annotate({
      description: "Human-readable name identifying this MCP server.",
    }),
    url: Schema.String.annotate({ description: "URL to the MCP server." }),
    headers: Schema.Array(HttpHeader).annotate({
      description: "HTTP headers to set when making requests to the MCP server.",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({ description: "SSE transport configuration for MCP." }),
  Schema.Struct({
    type: Schema.Literal("acp"),
    name: Schema.String.annotate({
      description: "Human-readable name identifying this MCP server.",
    }),
    serverId: Schema.suspend((): Schema.Codec<McpServerAcpId> => McpServerAcpId).annotate({
      description:
        "Unique identifier for this MCP server, generated by the component providing it.\n\nProviders MUST NOT reuse an ID for multiple ACP-transport MCP servers that are visible\non the same ACP connection.",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nACP transport configuration for MCP.\n\nThe MCP server is provided by an ACP component and communicates over the ACP channel\nusing `mcp/connect`, `mcp/message`, and `mcp/disconnect`.",
  }),
  Schema.suspend((): Schema.Codec<McpServerStdio> => McpServerStdio).annotate({
    title: "stdio",
    description: "Stdio transport configuration\n\nAll Agents MUST support this transport.",
  }),
]).annotate({
  description:
    "Configuration for connecting to an MCP (Model Context Protocol) server.\n\nMCP servers provide tools and context that the agent can use when\nprocessing prompts.\n\nSee protocol docs: [MCP Servers](https://agentclientprotocol.com/protocol/session-setup#mcp-servers)",
  identifier: "McpServer",
});

export type AuthMethod =
  | {
      readonly type: "terminal";
      readonly id: AuthMethodId;
      readonly name: string;
      readonly description?: string | null;
      readonly args?: ReadonlyArray<string>;
      readonly env?: { readonly [x: string]: string };
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | AuthMethodAgent;

export const AuthMethod = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("terminal"),
    id: Schema.suspend((): Schema.Codec<AuthMethodId> => AuthMethodId).annotate({
      description: "Unique identifier for this authentication method.",
    }),
    name: Schema.String.annotate({
      description: "Human-readable name of the authentication method.",
    }),
    description: Schema.optionalKey(
      Schema.Union([
        Schema.String.annotate({
          description:
            "Optional description providing more details about this authentication method.",
        }),
        Schema.Null,
      ]),
    ),
    args: Schema.optionalKey(
      Schema.Array(Schema.String).annotate({
        description:
          "Additional arguments to append to the configured agent invocation for terminal auth.",
      }),
    ),
    env: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.String).annotate({
        description:
          "Additional environment variables to set on the configured agent invocation for terminal auth.\nThese values override same-named variables in the base launch configuration.",
      }),
    ),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "Terminal-based authentication method.\n\nThe client runs the configured agent program as a separate interactive\nprocess for the user to authenticate via a TUI. Agents MUST advertise this\nmethod only when the client enabled its terminal authentication capability.\nA zero exit status signals success; any other termination signals failure.\nThe client MUST NOT pass this method to `authenticate`.",
  }),
  Schema.suspend((): Schema.Codec<AuthMethodAgent> => AuthMethodAgent).annotate({
    title: "agent",
    description:
      "Agent handles authentication itself through `authenticate`.\n\nThis is the default when no `type` is specified.",
  }),
]).annotate({
  description:
    "Describes an available authentication method.\n\nThe `type` field acts as the discriminator in the serialized JSON form.\nWhen no `type` is present, the method is treated as `agent`.",
  identifier: "AuthMethod",
});

export type ClientSessionCapabilities = {
  readonly compaction?: CompactionCapabilities | null;
  readonly configOptions?: SessionConfigOptionsCapabilities | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const ClientSessionCapabilities = Schema.Struct({
  compaction: Schema.optionalKey(
    Schema.Union([CompactionCapabilities, Schema.Null]).annotate({
      description:
        "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nSupport for ID-addressed context compaction updates. Omitted or `null`\nmeans unsupported; `{}` advertises the complete compaction contract.",
    }),
  ),
  configOptions: Schema.optionalKey(
    Schema.Union([SessionConfigOptionsCapabilities, Schema.Null]).annotate({
      description:
        "Config option capabilities supported by the client.\n\nOmitted or `null` both mean the client does not advertise support for any\nconfig option extensions.",
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Session-related capabilities supported by the client.",
  identifier: "ClientSessionCapabilities",
});

export type NesEventCapabilities = {
  readonly document?: NesDocumentEventCapabilities | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesEventCapabilities = Schema.Struct({
  document: Schema.optionalKey(
    Schema.Union([NesDocumentEventCapabilities, Schema.Null]).annotate({
      description: "Document event capabilities.",
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Event capabilities the agent can consume.",
  identifier: "NesEventCapabilities",
});

export type ToolCallContent =
  | {
      readonly type: "content";
      readonly content: ContentBlock;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly type: "diff";
      readonly path: string;
      readonly oldText?: string | null;
      readonly newText: string;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly type: "terminal";
      readonly terminalId: TerminalId;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    };

export const ToolCallContent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("content"),
    content: Schema.suspend((): Schema.Codec<ContentBlock> => ContentBlock).annotate({
      description: "The actual content block.",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({ description: "Standard content block (text, images, resources)." }),
  Schema.Struct({
    type: Schema.Literal("diff"),
    path: Schema.String.annotate({ description: "The absolute file path being modified." }),
    oldText: Schema.optionalKey(
      Schema.Union([
        Schema.String.annotate({ description: "The original content (None for new files)." }),
        Schema.Null,
      ]),
    ),
    newText: Schema.String.annotate({ description: "The new content after modification." }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "A diff representing file modifications.\n\nShows changes to files in a format suitable for display in the client UI.\n\nSee protocol docs: [Content](https://agentclientprotocol.com/protocol/tool-calls#content)",
  }),
  Schema.Struct({
    type: Schema.Literal("terminal"),
    terminalId: Schema.suspend((): Schema.Codec<TerminalId> => TerminalId).annotate({
      description: "Identifier of the terminal instance to embed in the content stream.",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "Embed a terminal created with `terminal/create` by its id.\n\nThe terminal must be added before calling `terminal/release`.\n\nSee protocol docs: [Terminal](https://agentclientprotocol.com/protocol/terminals)",
  }),
]).annotate({
  description:
    "Content produced by a tool call.\n\nTool calls can produce different types of content including\nstandard content blocks (text, images) or file diffs.\n\nSee protocol docs: [Content](https://agentclientprotocol.com/protocol/tool-calls#content)",
  identifier: "ToolCallContent",
});

export type PromptRequest = {
  readonly sessionId: SessionId;
  readonly prompt: ReadonlyArray<ContentBlock>;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const PromptRequest = Schema.Struct({
  sessionId: Schema.suspend((): Schema.Codec<SessionId> => SessionId).annotate({
    description: "The ID of the session to send this user message to",
  }),
  prompt: Schema.Array(ContentBlock).annotate({
    description:
      "The blocks of content that compose the user's message.\n\nAs a baseline, the Agent MUST support [`ContentBlock::Text`] and [`ContentBlock::ResourceLink`],\nwhile other variants are optionally enabled via [`PromptCapabilities`].\n\nThe Client MUST adapt its interface according to [`PromptCapabilities`].\n\nThe client MAY include referenced pieces of context as either\n[`ContentBlock::Resource`] or [`ContentBlock::ResourceLink`].\n\nWhen available, [`ContentBlock::Resource`] is preferred\nas it avoids extra round-trips and allows the message to include\npieces of context from sources the agent may not have access to.",
  }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Request parameters for sending a user prompt to the agent.\n\nContains the user's message and any additional context.\n\nSee protocol docs: [User Message](https://agentclientprotocol.com/protocol/prompt-turn#1-user-message)",
  identifier: "PromptRequest",
});

export type SessionConfigSelectOptions =
  | ReadonlyArray<SessionConfigSelectOption>
  | ReadonlyArray<SessionConfigSelectGroup>;

export const SessionConfigSelectOptions = Schema.Union([
  Schema.Array(SessionConfigSelectOption).annotate({
    title: "Ungrouped",
    description: "A flat list of options with no grouping.",
  }),
  Schema.Array(SessionConfigSelectGroup).annotate({
    title: "Grouped",
    description: "A list of options grouped under headers.",
  }),
]).annotate({
  description: "Possible values for a session configuration option.",
  identifier: "SessionConfigSelectOptions",
});

export type NewSessionRequest = {
  readonly cwd: string;
  readonly additionalDirectories?: ReadonlyArray<string>;
  readonly mcpServers: ReadonlyArray<McpServer>;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NewSessionRequest = Schema.Struct({
  cwd: Schema.String.annotate({
    description: "The working directory for this session. Must be an absolute path.",
  }),
  additionalDirectories: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "Additional workspace roots for this session. Each path must be absolute.\n\nThese expand the session's filesystem scope without changing `cwd`, which\nremains the base for relative paths. When omitted or empty, no\nadditional roots are activated for the new session.",
    }),
  ),
  mcpServers: Schema.Array(McpServer).annotate({
    description: "List of MCP (Model Context Protocol) servers the agent should connect to.",
  }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Request parameters for creating a new session.\n\nSee protocol docs: [Creating a Session](https://agentclientprotocol.com/protocol/session-setup#creating-a-session)",
  identifier: "NewSessionRequest",
});

export type LoadSessionRequest = {
  readonly mcpServers: ReadonlyArray<McpServer>;
  readonly cwd: string;
  readonly additionalDirectories?: ReadonlyArray<string>;
  readonly sessionId: SessionId;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const LoadSessionRequest = Schema.Struct({
  mcpServers: Schema.Array(McpServer).annotate({
    description: "List of MCP servers to connect to for this session.",
  }),
  cwd: Schema.String.annotate({
    description: "The working directory for this session. Must be an absolute path.",
  }),
  additionalDirectories: Schema.optionalKey(
    Schema.Array(Schema.String).annotate({
      description:
        "Additional workspace roots to activate for this session. Each path must be absolute.\n\nWhen omitted or empty, no additional roots are activated. When non-empty,\nthis is the complete resulting additional-root list for the loaded\nsession. It may differ from any previously used or reported list as long as\nthe request `cwd` matches the session's `cwd`.",
    }),
  ),
  sessionId: Schema.suspend((): Schema.Codec<SessionId> => SessionId).annotate({
    description: "The ID of the session to load.",
  }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Request parameters for loading an existing session.\n\nOnly available if the Agent supports the `loadSession` capability.\n\nSee protocol docs: [Loading Sessions](https://agentclientprotocol.com/protocol/session-setup#loading-sessions)",
  identifier: "LoadSessionRequest",
});

export type ClientCapabilities = {
  readonly fs?: FileSystemCapabilities;
  readonly terminal?: boolean;
  readonly session?: ClientSessionCapabilities | null;
  readonly plan?: PlanCapabilities | null;
  readonly auth?: AuthCapabilities;
  readonly elicitation?: ElicitationCapabilities | null;
  readonly nes?: ClientNesCapabilities | null;
  readonly positionEncodings?: ReadonlyArray<PositionEncodingKind>;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const ClientCapabilities = Schema.Struct({
  fs: Schema.optionalKey(
    Schema.suspend((): Schema.Codec<FileSystemCapabilities> => FileSystemCapabilities).annotate({
      description:
        "File system capabilities supported by the client.\nDetermines which file operations the agent can request.",
      default: { readTextFile: false, writeTextFile: false },
    }),
  ),
  terminal: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Whether the Client support all `terminal/*` methods.",
      default: false,
    }),
  ),
  session: Schema.optionalKey(
    Schema.Union([ClientSessionCapabilities, Schema.Null]).annotate({
      description:
        "Session-related capabilities supported by the client.\n\nOptional. Omitted or `null` both mean the client does not advertise any\nsession-related extensions.",
    }),
  ),
  plan: Schema.optionalKey(
    Schema.Union([PlanCapabilities, Schema.Null]).annotate({
      description:
        "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nWhether the client supports `plan_update` and `plan_removed` session updates.\n\nOptional. Omitted or `null` both mean the client does not advertise support.\nSupplying `{}` means the client can receive both update types.",
    }),
  ),
  auth: Schema.optionalKey(
    Schema.suspend((): Schema.Codec<AuthCapabilities> => AuthCapabilities).annotate({
      description:
        "Authentication capabilities supported by the client.\nDetermines which authentication method types the agent may include\nin its `InitializeResponse`.",
      default: { terminal: false },
    }),
  ),
  elicitation: Schema.optionalKey(
    Schema.Union([ElicitationCapabilities, Schema.Null]).annotate({
      description:
        "Elicitation capabilities supported by the client.\nDetermines which elicitation modes the agent may use.\n\nOptional. Omitted or `null` both mean the client does not advertise\nelicitation support.",
    }),
  ),
  nes: Schema.optionalKey(
    Schema.Union([ClientNesCapabilities, Schema.Null]).annotate({
      description:
        "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nNES (Next Edit Suggestions) capabilities supported by the client.\n\nOptional. Omitted or `null` both mean the client does not advertise any\nNES suggestion-kind extensions.",
    }),
  ),
  positionEncodings: Schema.optionalKey(
    Schema.Array(PositionEncodingKind).annotate({
      description:
        "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nThe position encodings supported by the client, in order of preference.",
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Capabilities supported by the client.\n\nAdvertised during initialization to inform the agent about\navailable features and methods.\n\nSee protocol docs: [Client Capabilities](https://agentclientprotocol.com/protocol/initialization#client-capabilities)",
  identifier: "ClientCapabilities",
});

export type NesCapabilities = {
  readonly events?: NesEventCapabilities | null;
  readonly context?: NesContextCapabilities | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NesCapabilities = Schema.Struct({
  events: Schema.optionalKey(
    Schema.Union([NesEventCapabilities, Schema.Null]).annotate({
      description: "Events the agent wants to receive.",
    }),
  ),
  context: Schema.optionalKey(
    Schema.Union([NesContextCapabilities, Schema.Null]).annotate({
      description: "Context the agent wants attached to each suggestion request.",
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "NES capabilities advertised by the agent during initialization.",
  identifier: "NesCapabilities",
});

export type ToolCallUpdate = {
  readonly toolCallId: ToolCallId;
  readonly kind?: ToolKind | null;
  readonly status?: ToolCallStatus | null;
  readonly title?: string | null;
  readonly name?: string | null;
  readonly content?: ReadonlyArray<ToolCallContent> | null;
  readonly locations?: ReadonlyArray<ToolCallLocation> | null;
  readonly rawInput?: Schema.Json;
  readonly rawOutput?: Schema.Json;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const ToolCallUpdate = Schema.Struct({
  toolCallId: Schema.suspend((): Schema.Codec<ToolCallId> => ToolCallId).annotate({
    description: "The ID of the tool call being updated.",
  }),
  kind: Schema.optionalKey(
    Schema.Union([ToolKind, Schema.Null]).annotate({ description: "Update the tool kind." }),
  ),
  status: Schema.optionalKey(
    Schema.Union([ToolCallStatus, Schema.Null]).annotate({
      description: "Update the execution status.",
    }),
  ),
  title: Schema.optionalKey(
    Schema.Union([
      Schema.String.annotate({ description: "Update the human-readable title." }),
      Schema.Null,
    ]),
  ),
  name: Schema.optionalKey(
    Schema.Union([
      Schema.String.annotate({
        description:
          "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nUpdate the programmatic name of the tool being invoked.\n\nThis field is optional. Omitting it or sending `null` both mean that\nthe existing name is left unchanged.",
      }),
      Schema.Null,
    ]),
  ),
  content: Schema.optionalKey(
    Schema.Union([
      Schema.Array(ToolCallContent).annotate({ description: "Replace the content collection." }),
      Schema.Null,
    ]),
  ),
  locations: Schema.optionalKey(
    Schema.Union([
      Schema.Array(ToolCallLocation).annotate({ description: "Replace the locations collection." }),
      Schema.Null,
    ]),
  ),
  rawInput: Schema.optionalKey(
    Schema.Json.annotate({ expected: "JSON value", description: "Update the raw input." }),
  ),
  rawOutput: Schema.optionalKey(
    Schema.Json.annotate({ expected: "JSON value", description: "Update the raw output." }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "An update to an existing tool call.\n\nUsed to report progress and results as tools execute. All fields except\nthe tool call ID are optional - only changed fields need to be included.\n\nSee protocol docs: [Updating](https://agentclientprotocol.com/protocol/tool-calls#updating)",
  identifier: "ToolCallUpdate",
});

export type SessionConfigOption =
  | {
      readonly id: SessionConfigId;
      readonly name: string;
      readonly description?: string | null;
      readonly category?: SessionConfigOptionCategory | null;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
      readonly type: "select";
      readonly currentValue: SessionConfigValueId;
      readonly options: SessionConfigSelectOptions;
    }
  | {
      readonly id: SessionConfigId;
      readonly name: string;
      readonly description?: string | null;
      readonly category?: SessionConfigOptionCategory | null;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
      readonly type: "boolean";
      readonly currentValue: boolean;
    };

export const SessionConfigOption = Schema.Union([
  Schema.Struct({
    id: Schema.suspend((): Schema.Codec<SessionConfigId> => SessionConfigId).annotate({
      description: "Unique identifier for the configuration option.",
    }),
    name: Schema.String.annotate({ description: "Human-readable label for the option." }),
    description: Schema.optionalKey(
      Schema.Union([
        Schema.String.annotate({
          description: "Optional description for the Client to display to the user.",
        }),
        Schema.Null,
      ]),
    ),
    category: Schema.optionalKey(
      Schema.Union([SessionConfigOptionCategory, Schema.Null]).annotate({
        description: "Optional semantic category for this option (UX only).",
      }),
    ),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
    type: Schema.Literal("select"),
    currentValue: Schema.suspend(
      (): Schema.Codec<SessionConfigValueId> => SessionConfigValueId,
    ).annotate({ description: "The currently selected value." }),
    options: Schema.suspend(
      (): Schema.Codec<SessionConfigSelectOptions> => SessionConfigSelectOptions,
    ).annotate({ description: "The set of selectable options." }),
  }).annotate({
    description: "A single-value selector (dropdown) session configuration option payload.",
  }),
  Schema.Struct({
    id: Schema.suspend((): Schema.Codec<SessionConfigId> => SessionConfigId).annotate({
      description: "Unique identifier for the configuration option.",
    }),
    name: Schema.String.annotate({ description: "Human-readable label for the option." }),
    description: Schema.optionalKey(
      Schema.Union([
        Schema.String.annotate({
          description: "Optional description for the Client to display to the user.",
        }),
        Schema.Null,
      ]),
    ),
    category: Schema.optionalKey(
      Schema.Union([SessionConfigOptionCategory, Schema.Null]).annotate({
        description: "Optional semantic category for this option (UX only).",
      }),
    ),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
    type: Schema.Literal("boolean"),
    currentValue: Schema.Boolean.annotate({
      description: "The current value of the boolean option.",
    }),
  }).annotate({ description: "A boolean on/off toggle session configuration option payload." }),
]).annotate({ identifier: "SessionConfigOption" });

export type InitializeRequest = {
  readonly protocolVersion: ProtocolVersion;
  readonly clientCapabilities?: ClientCapabilities;
  readonly clientInfo?: Implementation | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const InitializeRequest = Schema.Struct({
  protocolVersion: Schema.suspend((): Schema.Codec<ProtocolVersion> => ProtocolVersion).annotate({
    description: "The latest protocol version supported by the client.",
  }),
  clientCapabilities: Schema.optionalKey(
    Schema.suspend((): Schema.Codec<ClientCapabilities> => ClientCapabilities).annotate({
      description: "Capabilities supported by the client.",
      default: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        auth: { terminal: false },
      },
    }),
  ),
  clientInfo: Schema.optionalKey(
    Schema.Union([Implementation, Schema.Null]).annotate({
      description:
        "Information about the Client name and version sent to the Agent.\n\nNote: in future versions of the protocol, this will be required.",
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Request parameters for the initialize method.\n\nSent by the client to establish connection and negotiate capabilities.\n\nSee protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)",
  identifier: "InitializeRequest",
});

export type AgentCapabilities = {
  readonly loadSession?: boolean;
  readonly promptCapabilities?: PromptCapabilities;
  readonly mcpCapabilities?: McpCapabilities;
  readonly sessionCapabilities?: SessionCapabilities;
  readonly auth?: AgentAuthCapabilities;
  readonly providers?: ProvidersCapabilities | null;
  readonly nes?: NesCapabilities | null;
  readonly positionEncoding?: PositionEncodingKind | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const AgentCapabilities = Schema.Struct({
  loadSession: Schema.optionalKey(
    Schema.Boolean.annotate({
      description: "Whether the agent supports `session/load`.",
      default: false,
    }),
  ),
  promptCapabilities: Schema.optionalKey(
    Schema.suspend((): Schema.Codec<PromptCapabilities> => PromptCapabilities).annotate({
      description: "Prompt capabilities supported by the agent.",
      default: { image: false, audio: false, embeddedContext: false },
    }),
  ),
  mcpCapabilities: Schema.optionalKey(
    Schema.suspend((): Schema.Codec<McpCapabilities> => McpCapabilities).annotate({
      description: "MCP capabilities supported by the agent.",
      default: { http: false, sse: false, acp: false },
    }),
  ),
  sessionCapabilities: Schema.optionalKey(
    Schema.suspend((): Schema.Codec<SessionCapabilities> => SessionCapabilities).annotate({
      description: "Session lifecycle and prompt capabilities advertised by the agent.",
      default: {},
    }),
  ),
  auth: Schema.optionalKey(
    Schema.suspend((): Schema.Codec<AgentAuthCapabilities> => AgentAuthCapabilities).annotate({
      description: "Authentication-related capabilities supported by the agent.",
      default: {},
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Union([ProvidersCapabilities, Schema.Null]).annotate({
      description:
        "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nProvider configuration capabilities supported by the agent.\n\nOptional. Omitted or `null` both mean the agent does not advertise support.\nSupplying `{}` means the agent supports provider configuration methods.",
    }),
  ),
  nes: Schema.optionalKey(
    Schema.Union([NesCapabilities, Schema.Null]).annotate({
      description:
        "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nNES (Next Edit Suggestions) capabilities supported by the agent.\n\nOptional. Omitted or `null` both mean the agent does not advertise support\nfor NES methods.",
    }),
  ),
  positionEncoding: Schema.optionalKey(
    Schema.Union([PositionEncodingKind, Schema.Null]).annotate({
      description:
        "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nThe position encoding selected by the agent from the client's supported encodings.",
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Capabilities supported by the agent.\n\nAdvertised during initialization to inform the client about\navailable features and content types.\n\nSee protocol docs: [Agent Capabilities](https://agentclientprotocol.com/protocol/initialization#agent-capabilities)",
  identifier: "AgentCapabilities",
});

export type RequestPermissionRequest = {
  readonly sessionId: SessionId;
  readonly toolCall: ToolCallUpdate;
  readonly options: ReadonlyArray<PermissionOption>;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const RequestPermissionRequest = Schema.Struct({
  sessionId: Schema.suspend((): Schema.Codec<SessionId> => SessionId).annotate({
    description: "The session ID for this request.",
  }),
  toolCall: Schema.suspend((): Schema.Codec<ToolCallUpdate> => ToolCallUpdate).annotate({
    description: "Details about the tool call requiring permission.",
  }),
  options: Schema.Array(PermissionOption).annotate({
    description: "Available permission options for the user to choose from.",
  }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Request for user permission to execute a tool call.\n\nSent when the agent needs authorization before performing a sensitive operation.\n\nSee protocol docs: [Requesting Permission](https://agentclientprotocol.com/protocol/tool-calls#requesting-permission)",
  identifier: "RequestPermissionRequest",
});

export type SessionUpdate =
  | {
      readonly sessionUpdate: "user_message_chunk";
      readonly content: ContentBlock;
      readonly messageId?: MessageId | null;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly sessionUpdate: "agent_message_chunk";
      readonly content: ContentBlock;
      readonly messageId?: MessageId | null;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly sessionUpdate: "agent_thought_chunk";
      readonly content: ContentBlock;
      readonly messageId?: MessageId | null;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly sessionUpdate: "tool_call";
      readonly toolCallId: ToolCallId;
      readonly title: string;
      readonly name?: string | null;
      readonly kind?: ToolKind;
      readonly status?: ToolCallStatus;
      readonly content?: ReadonlyArray<ToolCallContent>;
      readonly locations?: ReadonlyArray<ToolCallLocation>;
      readonly rawInput?: Schema.Json;
      readonly rawOutput?: Schema.Json;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly sessionUpdate: "tool_call_update";
      readonly toolCallId: ToolCallId;
      readonly kind?: ToolKind | null;
      readonly status?: ToolCallStatus | null;
      readonly title?: string | null;
      readonly name?: string | null;
      readonly content?: ReadonlyArray<ToolCallContent> | null;
      readonly locations?: ReadonlyArray<ToolCallLocation> | null;
      readonly rawInput?: Schema.Json;
      readonly rawOutput?: Schema.Json;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly sessionUpdate: "plan";
      readonly entries: ReadonlyArray<PlanEntry>;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly sessionUpdate: "plan_update";
      readonly plan: PlanUpdateContent;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly sessionUpdate: "plan_removed";
      readonly planId: PlanId;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly sessionUpdate: "available_commands_update";
      readonly availableCommands: ReadonlyArray<AvailableCommand>;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly sessionUpdate: "current_mode_update";
      readonly currentModeId: SessionModeId;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly sessionUpdate: "config_option_update";
      readonly configOptions: ReadonlyArray<SessionConfigOption>;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly sessionUpdate: "session_info_update";
      readonly title?: string | null;
      readonly updatedAt?: string | null;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly sessionUpdate: "usage_update";
      readonly used: number;
      readonly size: number;
      readonly cost?: Cost | null;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly sessionUpdate: "compaction_update";
      readonly compactionId: CompactionId;
      readonly status: CompactionStatus;
      readonly summary?: ReadonlyArray<ContentBlock> | null;
      readonly error?: string | null;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    }
  | {
      readonly sessionUpdate: "compaction_summary_chunk";
      readonly compactionId: CompactionId;
      readonly content: ContentBlock;
      readonly _meta?: { readonly [x: string]: Schema.Json } | null;
    };

export const SessionUpdate = Schema.Union([
  Schema.Struct({
    sessionUpdate: Schema.Literal("user_message_chunk"),
    content: Schema.suspend((): Schema.Codec<ContentBlock> => ContentBlock).annotate({
      description: "A single item of content",
    }),
    messageId: Schema.optionalKey(
      Schema.Union([MessageId, Schema.Null]).annotate({
        description:
          "A unique identifier for the message this chunk belongs to.\n\nAll chunks belonging to the same message share the same `messageId`.\nA change in `messageId` indicates a new message has started.",
      }),
    ),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({ description: "A streamed item of content" }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("agent_message_chunk"),
    content: Schema.suspend((): Schema.Codec<ContentBlock> => ContentBlock).annotate({
      description: "A single item of content",
    }),
    messageId: Schema.optionalKey(
      Schema.Union([MessageId, Schema.Null]).annotate({
        description:
          "A unique identifier for the message this chunk belongs to.\n\nAll chunks belonging to the same message share the same `messageId`.\nA change in `messageId` indicates a new message has started.",
      }),
    ),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({ description: "A streamed item of content" }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("agent_thought_chunk"),
    content: Schema.suspend((): Schema.Codec<ContentBlock> => ContentBlock).annotate({
      description: "A single item of content",
    }),
    messageId: Schema.optionalKey(
      Schema.Union([MessageId, Schema.Null]).annotate({
        description:
          "A unique identifier for the message this chunk belongs to.\n\nAll chunks belonging to the same message share the same `messageId`.\nA change in `messageId` indicates a new message has started.",
      }),
    ),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({ description: "A streamed item of content" }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("tool_call"),
    toolCallId: Schema.suspend((): Schema.Codec<ToolCallId> => ToolCallId).annotate({
      description: "Unique identifier for this tool call within the session.",
    }),
    title: Schema.String.annotate({
      description: "Human-readable title describing what the tool is doing.",
    }),
    name: Schema.optionalKey(
      Schema.Union([
        Schema.String.annotate({
          description:
            "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nProgrammatic name of the tool being invoked.\n\nThis field is optional. Omitting it or sending `null` both mean that no\ntool name is available.",
        }),
        Schema.Null,
      ]),
    ),
    kind: Schema.optionalKey(
      Schema.suspend((): Schema.Codec<ToolKind> => ToolKind).annotate({
        description:
          "The category of tool being invoked.\nHelps clients choose appropriate icons and UI treatment.",
      }),
    ),
    status: Schema.optionalKey(
      Schema.suspend((): Schema.Codec<ToolCallStatus> => ToolCallStatus).annotate({
        description: "Current execution status of the tool call.",
      }),
    ),
    content: Schema.optionalKey(
      Schema.Array(ToolCallContent).annotate({ description: "Content produced by the tool call." }),
    ),
    locations: Schema.optionalKey(
      Schema.Array(ToolCallLocation).annotate({
        description:
          'File locations affected by this tool call.\nEnables "follow-along" features in clients.',
      }),
    ),
    rawInput: Schema.optionalKey(
      Schema.Json.annotate({
        expected: "JSON value",
        description: "Raw input parameters sent to the tool.",
      }),
    ),
    rawOutput: Schema.optionalKey(
      Schema.Json.annotate({
        expected: "JSON value",
        description: "Raw output returned by the tool.",
      }),
    ),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "Represents a tool call that the language model has requested.\n\nTool calls are actions that the agent executes on behalf of the language model,\nsuch as reading files, executing code, or fetching data from external sources.\n\nSee protocol docs: [Tool Calls](https://agentclientprotocol.com/protocol/tool-calls)",
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("tool_call_update"),
    toolCallId: Schema.suspend((): Schema.Codec<ToolCallId> => ToolCallId).annotate({
      description: "The ID of the tool call being updated.",
    }),
    kind: Schema.optionalKey(
      Schema.Union([ToolKind, Schema.Null]).annotate({ description: "Update the tool kind." }),
    ),
    status: Schema.optionalKey(
      Schema.Union([ToolCallStatus, Schema.Null]).annotate({
        description: "Update the execution status.",
      }),
    ),
    title: Schema.optionalKey(
      Schema.Union([
        Schema.String.annotate({ description: "Update the human-readable title." }),
        Schema.Null,
      ]),
    ),
    name: Schema.optionalKey(
      Schema.Union([
        Schema.String.annotate({
          description:
            "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nUpdate the programmatic name of the tool being invoked.\n\nThis field is optional. Omitting it or sending `null` both mean that\nthe existing name is left unchanged.",
        }),
        Schema.Null,
      ]),
    ),
    content: Schema.optionalKey(
      Schema.Union([
        Schema.Array(ToolCallContent).annotate({ description: "Replace the content collection." }),
        Schema.Null,
      ]),
    ),
    locations: Schema.optionalKey(
      Schema.Union([
        Schema.Array(ToolCallLocation).annotate({
          description: "Replace the locations collection.",
        }),
        Schema.Null,
      ]),
    ),
    rawInput: Schema.optionalKey(
      Schema.Json.annotate({ expected: "JSON value", description: "Update the raw input." }),
    ),
    rawOutput: Schema.optionalKey(
      Schema.Json.annotate({ expected: "JSON value", description: "Update the raw output." }),
    ),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "An update to an existing tool call.\n\nUsed to report progress and results as tools execute. All fields except\nthe tool call ID are optional - only changed fields need to be included.\n\nSee protocol docs: [Updating](https://agentclientprotocol.com/protocol/tool-calls#updating)",
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("plan"),
    entries: Schema.Array(PlanEntry).annotate({
      description:
        "The list of tasks to be accomplished.\n\nWhen updating a plan, the agent must send a complete list of all entries\nwith their current status. The client replaces the entire plan with each update.",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "An execution plan for accomplishing complex tasks.\n\nPlans consist of multiple entries representing individual tasks or goals.\nAgents report plans to clients to provide visibility into their execution strategy.\nPlans can evolve during execution as the agent discovers new requirements or completes tasks.\n\nSee protocol docs: [Agent Plan](https://agentclientprotocol.com/protocol/agent-plan)",
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("plan_update"),
    plan: Schema.suspend((): Schema.Codec<PlanUpdateContent> => PlanUpdateContent).annotate({
      description: "The updated plan content.",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nA content update for a plan identified by ID.",
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("plan_removed"),
    planId: Schema.suspend((): Schema.Codec<PlanId> => PlanId).annotate({
      description: "The plan ID to remove.",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nRemoval notice for a plan identified by ID.",
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("available_commands_update"),
    availableCommands: Schema.Array(AvailableCommand).annotate({
      description: "Commands the agent can execute",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({ description: "Available commands are ready or have changed" }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("current_mode_update"),
    currentModeId: Schema.suspend((): Schema.Codec<SessionModeId> => SessionModeId).annotate({
      description: "The ID of the current mode",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "The current mode of the session has changed\n\nSee protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes)",
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("config_option_update"),
    configOptions: Schema.Array(SessionConfigOption).annotate({
      description: "The full set of configuration options and their current values.",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({ description: "Session configuration options have been updated." }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("session_info_update"),
    title: Schema.optionalKey(
      Schema.Union([
        Schema.String.annotate({
          description: "Human-readable title for the session. Set to null to clear.",
        }),
        Schema.Null,
      ]),
    ),
    updatedAt: Schema.optionalKey(
      Schema.Union([
        Schema.String.annotate({
          description: "ISO 8601 timestamp of last activity. Set to null to clear.",
        }),
        Schema.Null,
      ]),
    ),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "Update to session metadata. All fields are optional to support partial updates.\n\nAgents send this notification to update session information like title or custom metadata.\nThis allows clients to display dynamic session names and track session state changes.",
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("usage_update"),
    used: Schema.Number.annotate({ description: "Tokens currently in context.", format: "uint64" })
      .check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(0).annotate({
          expected: "a value greater than or equal to 0",
        }),
      ),
    size: Schema.Number.annotate({
      description: "Total context window size in tokens.",
      format: "uint64",
    })
      .check(Schema.isInt().annotate({ expected: "an integer" }))
      .check(
        Schema.isGreaterThanOrEqualTo(0).annotate({
          expected: "a value greater than or equal to 0",
        }),
      ),
    cost: Schema.optionalKey(
      Schema.Union([Cost, Schema.Null]).annotate({
        description: "Cumulative session cost (optional).",
      }),
    ),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description:
            "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({ description: "Context window and cost update for a session." }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("compaction_update"),
    compactionId: Schema.suspend((): Schema.Codec<CompactionId> => CompactionId).annotate({
      description: "The Agent-owned ID of this compaction, unique within the session.",
    }),
    status: Schema.suspend((): Schema.Codec<CompactionStatus> => CompactionStatus).annotate({
      description: "Current lifecycle status.",
    }),
    summary: Schema.optionalKey(
      Schema.Union([
        Schema.Array(ContentBlock).annotate({
          description: "Complete replacement user-displayable summary retained by the compaction.",
        }),
        Schema.Null,
      ]),
    ),
    error: Schema.optionalKey(
      Schema.Union([
        Schema.String.annotate({
          description: "Human-readable description of why the compaction failed.",
        }),
        Schema.Null,
      ]),
    ),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description: "Extensible metadata patch for this compaction.",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nA context compaction upsert. The first update fixes the compaction's\ntimeline position. Later updates with the same ID patch that entity in place.\nAgents MUST only send this update when the Client advertised\n[`ClientSessionCapabilities::compaction`].\n\n`summary`, `error`, and `_meta` have patch semantics: omission leaves the\nstored value unchanged, `null` clears it, and a concrete value replaces it.\n`summary: []` also clears the retained summary. A non-empty summary is only\nvalid with `completed`; `error` is only valid with `failed`.",
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("compaction_summary_chunk"),
    compactionId: Schema.suspend((): Schema.Codec<CompactionId> => CompactionId).annotate({
      description: "ID of the compaction whose summary receives this content.",
    }),
    content: Schema.suspend((): Schema.Codec<ContentBlock> => ContentBlock).annotate({
      description: "One content block to append.",
    }),
    _meta: Schema.optionalKey(
      Schema.Union([
        Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
          description: "Metadata scoped to this chunk. Omission and `null` both mean absent.",
        }),
        Schema.Null,
      ]),
    ),
  }).annotate({
    description:
      "**UNSTABLE**\n\nThis capability is not part of the spec yet, and may be removed or changed at any point.\n\nA content block appended to the retained summary of an in-progress\ncompaction. Agents send chunks only after an `in_progress` update and before\nthe terminal update for the same ID. Agents MUST only send this update when\nthe Client advertised [`ClientSessionCapabilities::compaction`].",
  }),
]).annotate({
  description:
    "Different types of updates that can be sent during session processing.\n\nThese updates provide real-time feedback about the agent's progress.\n\nSee protocol docs: [Agent Reports Output](https://agentclientprotocol.com/protocol/prompt-turn#3-agent-reports-output)",
  identifier: "SessionUpdate",
});

export type NewSessionResponse = {
  readonly sessionId: SessionId;
  readonly modes?: SessionModeState | null;
  readonly configOptions?: ReadonlyArray<SessionConfigOption> | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const NewSessionResponse = Schema.Struct({
  sessionId: Schema.suspend((): Schema.Codec<SessionId> => SessionId).annotate({
    description:
      "Unique identifier for the created session.\n\nUsed in all subsequent requests for this conversation.",
  }),
  modes: Schema.optionalKey(
    Schema.Union([SessionModeState, Schema.Null]).annotate({
      description:
        "Initial mode state if supported by the Agent\n\nSee protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes)",
    }),
  ),
  configOptions: Schema.optionalKey(
    Schema.Union([
      Schema.Array(SessionConfigOption).annotate({
        description: "Initial session configuration options if supported by the Agent.",
      }),
      Schema.Null,
    ]),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Response from creating a new session.\n\nSee protocol docs: [Creating a Session](https://agentclientprotocol.com/protocol/session-setup#creating-a-session)",
  identifier: "NewSessionResponse",
});

export type LoadSessionResponse = {
  readonly modes?: SessionModeState | null;
  readonly configOptions?: ReadonlyArray<SessionConfigOption> | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const LoadSessionResponse = Schema.Struct({
  modes: Schema.optionalKey(
    Schema.Union([SessionModeState, Schema.Null]).annotate({
      description:
        "Initial mode state if supported by the Agent\n\nSee protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes)",
    }),
  ),
  configOptions: Schema.optionalKey(
    Schema.Union([
      Schema.Array(SessionConfigOption).annotate({
        description: "Initial session configuration options if supported by the Agent.",
      }),
      Schema.Null,
    ]),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description: "Response from loading an existing session.",
  identifier: "LoadSessionResponse",
});

export type InitializeResponse = {
  readonly protocolVersion: ProtocolVersion;
  readonly agentCapabilities?: AgentCapabilities;
  readonly authMethods?: ReadonlyArray<AuthMethod>;
  readonly agentInfo?: Implementation | null;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const InitializeResponse = Schema.Struct({
  protocolVersion: Schema.suspend((): Schema.Codec<ProtocolVersion> => ProtocolVersion).annotate({
    description:
      "The protocol version the client specified if supported by the agent,\nor the latest protocol version supported by the agent.\n\nThe client should disconnect, if it doesn't support this version.",
  }),
  agentCapabilities: Schema.optionalKey(
    Schema.suspend((): Schema.Codec<AgentCapabilities> => AgentCapabilities).annotate({
      description: "Capabilities supported by the agent.",
      default: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        mcpCapabilities: { http: false, sse: false, acp: false },
        sessionCapabilities: {},
        auth: {},
      },
    }),
  ),
  authMethods: Schema.optionalKey(
    Schema.Array(AuthMethod).annotate({
      description: "Authentication methods supported by the agent.",
      default: [],
    }),
  ),
  agentInfo: Schema.optionalKey(
    Schema.Union([Implementation, Schema.Null]).annotate({
      description:
        "Information about the Agent name and version sent to the Client.\n\nNote: in future versions of the protocol, this will be required.",
    }),
  ),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Response to the `initialize` method.\n\nContains the negotiated protocol version and agent capabilities.\n\nSee protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)",
  identifier: "InitializeResponse",
});

export type SessionNotification = {
  readonly sessionId: SessionId;
  readonly update: SessionUpdate;
  readonly _meta?: { readonly [x: string]: Schema.Json } | null;
};

export const SessionNotification = Schema.Struct({
  sessionId: Schema.suspend((): Schema.Codec<SessionId> => SessionId).annotate({
    description: "The ID of the session this update pertains to.",
  }),
  update: Schema.suspend((): Schema.Codec<SessionUpdate> => SessionUpdate).annotate({
    description: "The actual update content.",
  }),
  _meta: Schema.optionalKey(
    Schema.Union([
      Schema.Record(Schema.String, Schema.Json.annotate({ expected: "JSON value" })).annotate({
        description:
          "The _meta property is reserved by ACP to allow clients and agents to attach additional\nmetadata to their interactions. Implementations MUST NOT make assumptions about values at\nthese keys.\n\nSee protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)",
      }),
      Schema.Null,
    ]),
  ),
}).annotate({
  description:
    "Notification containing a session update from the agent.\n\nUsed to stream real-time progress and results during prompt processing.\n\nSee protocol docs: [Agent Reports Output](https://agentclientprotocol.com/protocol/prompt-turn#3-agent-reports-output)",
  identifier: "SessionNotification",
});
