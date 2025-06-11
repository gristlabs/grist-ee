import { ApplyUAResult } from "app/common/ActiveDocAPI";
import {
  AssistanceMessage,
  AssistanceRequestV2,
  AssistanceResponseV2,
} from "app/common/Assistance";
import { AssistantProvider } from "app/common/Assistant";
import { delay } from "app/common/delay";
import { CellValue, getColValues, RowRecord } from "app/common/DocActions";
import { safeJsonParse } from "app/common/gutil";
import { arrayRepeat } from "app/plugin/gutil";
import {
  handleSandboxErrorOnPlatform,
  TableOperationsPlatform,
} from "app/plugin/TableOperationsImpl";
import { OptDocSession } from "app/server/lib/DocSession";
import {
  AssistanceDoc,
  AssistantV2,
  AssistantV2Options,
  FunctionCallResult,
  FunctionCallSuccess,
  OpenAIChatCompletion,
  OpenAITool,
} from "app/server/lib/IAssistant";
import {
  getProviderFromHostname,
  getUserHash,
  NonRetryableError,
  QuotaExceededError,
  RetryableError,
  TokensExceededError,
  TokensExceededFirstMessageError,
  TokensExceededLaterMessageError,
} from "app/server/lib/Assistant";
import log from "app/server/lib/log";
import { stringParam } from "app/server/lib/requestUtils";
import { runSQLQuery } from "app/server/lib/runSQLQuery";
import { pick } from "lodash";
import moment from "moment";
import fetch from "node-fetch";

export const DEPS = { fetch, delayTime: 1000 };

/**
 * A flavor of assistant for use with the OpenAI chat completion endpoint
 * and tools with a compatible endpoint (e.g. llama-cpp-python).
 * Tested primarily with gpt-4o.
 *
 * In addition to everything supported by OpenAIAssistantV1, this assistant
 * supports basic table data operations (add/update/delete), SQL analysis of
 * document structure and data, and expanded formula assistance support
 * (e.g. trigger formulas). The new capabilities rely on the ability of
 * the model to make tool/function calls. An optional ASSISTANT_MAX_TOOL_CALLS
 * can be specified.
 *
 * Uses the ASSISTANT_CHAT_COMPLETION_ENDPOINT endpoint if set, else an
 * OpenAI endpoint. Passes ASSISTANT_API_KEY or OPENAI_API_KEY in a
 * header if set. An api key is required for the default OpenAI endpoint.
 *
 * If a model string is set in ASSISTANT_MODEL, this will be passed
 * along. For the default OpenAI endpoint, a gpt-4o variant will be
 * set by default.
 *
 * If a request fails because of context length limitation, and
 * ASSISTANT_LONGER_CONTEXT_MODEL is set, the request will be retried
 * with that model.
 *
 * An optional ASSISTANT_MAX_TOKENS can be specified.
 */
export class OpenAIAssistantV2 implements AssistantV2 {
  public static readonly VERSION = 2;
  public static readonly DEFAULT_MODEL = "gpt-4o-2024-08-06";
  public static readonly DEFAULT_LONGER_CONTEXT_MODEL = undefined;

  private _apiKey = this._options.apiKey;
  private _endpoint =
    this._options.completionEndpoint ??
    "https://api.openai.com/v1/chat/completions";
  private _model = this._options.model ?? null;
  private _longerContextModel = this._options.longerContextModel;
  private _maxTokens = this._options.maxTokens;
  private _maxToolCalls = this._options.maxToolCalls ?? 10;

  public constructor(private _options: AssistantV2Options) {
    if (!this._apiKey && !_options.completionEndpoint) {
      throw new Error(
        "Please set ASSISTANT_API_KEY or ASSISTANT_CHAT_COMPLETION_ENDPOINT"
      );
    }

    if (!_options.completionEndpoint) {
      this._model ||= OpenAIAssistantV2.DEFAULT_MODEL;
      this._longerContextModel ||=
        OpenAIAssistantV2.DEFAULT_LONGER_CONTEXT_MODEL;
    }
  }

  public async getAssistance(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    request: AssistanceRequestV2
  ): Promise<AssistanceResponseV2> {
    let completion = await this._getCompletion(docSession, doc, request);
    let calls = 0;
    const appliedActions: ApplyUAResult[] = [];
    while (completion.choice.finish_reason === "tool_calls") {
      if (calls > this._maxToolCalls) {
        throw new Error(
          "There was a problem fulfilling your request. Please try again."
        );
      }
      const result = await this._handleToolCalls(
        docSession,
        doc,
        request,
        completion
      );
      if (result.appliedActions) {
        appliedActions.push(...result.appliedActions);
      }
      completion = result.completion;
      calls++;
    }
    const response = this._buildResponse(completion, appliedActions);
    doc.logTelemetryEvent(docSession, "assistantReceive", {
      full: {
        version: 2,
        conversationId: request.conversationId,
        context: request.context,
        message: {
          index: response.state?.messages
            ? response.state.messages.length - 1
            : -1,
          content: completion,
        },
      },
    });
    return response;
  }

  public get version(): AssistantV2["version"] {
    return OpenAIAssistantV2.VERSION;
  }

  public get provider(): AssistantProvider {
    return getProviderFromHostname(this._endpoint);
  }

  private async _getCompletion(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    request: AssistanceRequestV2
  ): Promise<OpenAIChatCompletion> {
    const messages = await this._buildMessages(docSession, doc, request);
    this._logSendCompletionTelemetry({
      docSession,
      doc,
      request,
      messages,
    });

    const user = getUserHash(docSession);
    let lastError: Error | undefined;

    // First try fetching the completion with the default model. If we hit the
    // token limit and a model with a longer context length is available, try
    // that one too.
    for (const model of [this._model, this._longerContextModel]) {
      if (model === undefined) {
        continue;
      }

      try {
        return await this._fetchCompletionWithRetries(messages, {
          user,
          model,
        });
      } catch (e) {
        if (!(e instanceof TokensExceededError)) {
          throw e;
        }

        lastError = e;
      }
    }

    throw lastError;
  }

  private async _buildMessages(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    request: AssistanceRequestV2
  ) {
    const messages = request.state?.messages || [];
    messages[0] = await this._getDeveloperPrompt(docSession, doc, request);
    if (request.text) {
      messages.push({
        role: "user",
        content: request.text,
      });
    }
    return messages;
  }

  private _logSendCompletionTelemetry(options: {
    docSession: OptDocSession;
    doc: AssistanceDoc;
    request: AssistanceRequestV2;
    messages: AssistanceMessage[];
  }) {
    const { docSession, doc, request, messages } = options;
    const { conversationId, state } = request;
    const oldMessages = state?.messages ?? [];
    const start = oldMessages.length;
    const newMessages = messages.slice(start);
    for (const [index, { role, content }] of newMessages.entries()) {
      doc.logTelemetryEvent(docSession, "assistantSend", {
        full: {
          version: 2,
          conversationId,
          context: "context" in request ? request.context : undefined,
          prompt: {
            index: start + index,
            role,
            content,
          },
        },
      });
    }
  }

  private async _fetchCompletion(
    messages: AssistanceMessage[],
    params: {
      user: string;
      model: string | null;
    }
  ): Promise<OpenAIChatCompletion> {
    const { user, model } = params;
    const apiResponse = await DEPS.fetch(this._endpoint, {
      method: "POST",
      headers: {
        ...(this._apiKey
          ? {
              Authorization: `Bearer ${this._apiKey}`,
              "api-key": this._apiKey,
            }
          : undefined),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages,
        temperature: 0,
        ...(model ? { model } : undefined),
        response_format: this._getResponseFormat(),
        tools: this._getTools(),
        user,
        ...(this._maxTokens
          ? {
              max_tokens: this._maxTokens,
            }
          : undefined),
      }),
    });
    const resultText = await apiResponse.text();
    const result = JSON.parse(resultText);
    const errorCode = result.error?.code;
    const errorMessage = result.error?.message;
    if (
      errorCode === "context_length_exceeded" ||
      result.choices?.[0].finish_reason === "length"
    ) {
      log.warn("AI context length exceeded: ", errorMessage);
      if (messages.length <= 2) {
        throw new TokensExceededFirstMessageError();
      } else {
        throw new TokensExceededLaterMessageError();
      }
    }
    if (errorCode === "insufficient_quota") {
      log.error("AI service provider billing quota exceeded!!!");
      throw new QuotaExceededError();
    }
    if (apiResponse.status !== 200) {
      throw new Error(
        `AI service provider API returned status ${apiResponse.status}: ${resultText}`
      );
    }
    const {
      message: { content, refusal, tool_calls },
      finish_reason,
    } = result.choices[0];
    return {
      choice: {
        message: {
          content,
          refusal,
          tool_calls,
        },
        finish_reason,
      },
      state: {
        messages: [...messages, result.choices[0].message],
      },
    };
  }

  private async _fetchCompletionWithRetries(
    messages: AssistanceMessage[],
    params: {
      user: string;
      model: string | null;
    }
  ): Promise<OpenAIChatCompletion> {
    let lastError: Error;
    let attempts = 0;
    const maxAttempts = 3;
    while (attempts < maxAttempts) {
      try {
        return await this._fetchCompletion(messages, params);
      } catch (e) {
        if (e instanceof NonRetryableError) {
          throw e;
        }

        attempts += 1;
        if (attempts === maxAttempts) {
          lastError = e;
          break;
        }

        log.warn(`Waiting and then retrying after error: ${e}`);
        await delay(1000);
      }
    }

    throw new RetryableError(lastError!.toString());
  }

  /**
   * Returns the developer/system prompt for the assistant.
   *
   * This prompt is used to set the context and instructions for the AI assistant.
   * It loosely follows recommendations from
   * https://platform.openai.com/docs/guides/text?api-mode=responses#message-formatting-with-markdown-and-xml
   * and https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags. Notably, the
   * prompt is structured using XML and defines the assistant's identity, instructions, example queries, and
   * useful context like the current date and visible tables.
   *
   * Tools are mentioned in select sections to reinforce their usage, but the actual tool definitions
   * are provided separately (see `_getTools`).
   *
   * The prompt is still a work in progress and will evolve over time.
   */
  private async _getDeveloperPrompt(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    request: AssistanceRequestV2
  ): Promise<AssistanceMessage> {
    const {
      context: { viewId },
    } = request;
    const visibleTableIds = viewId
      ? await getVisibleTableIds(docSession, doc, viewId)
      : undefined;
    const content = `<identity>
You are an AI assistant for [Grist](https://www.getgrist.com), a collaborative spreadsheet-meets-database.
</identity>

<instructions>
Help users answer questions about their document, modify records or schema, or write formulas.
Always explain the proposed changes in plain language.
Do not call modification APIs (e.g. add_records, update_records) until the user confirms explicitly.
</instructions>

<tool_instructions>
Use get_tables and get_columns to discover valid IDs.
When the user refers to a column label, match it to the ID using get_columns.
If a table or column doesn't exist, check it hasn't been removed since you last queried the schema.
If a call fails due to insufficient access, tell the user they need full access to the document.
</tool_instructions>

<query_document_instructions>
Generate a single SQL SELECT query and call query_document.
Only SQLite-compatible SQL is supported.
</query_document_instructions>

<modification_instructions>
Always use column IDs, not labels.
Never set the id field in records.
For updates or deletions, first query the table for id values.
Only records, columns, or tables can be modified.
When setting choice_styles, only use values like:
\`{"Choice 1": {"textColor": "#FFFFFF", "fillColor": "#16B378",
"fontUnderline": false, "fontItalic": false, "fontStrikethrough": false}}\`
Use values appropriate for each column's type (see table below).
Prefix lists with an "L" element (e.g., \`["L", 1, 2, 3]\`).

| Column Type | Value Format | Description                                          | Examples                       |
|-------------|--------------|------------------------------------------------------|--------------------------------|
| Any         | any          | Any value                                            | \`"Alice"\`, \`123\`, \`true\` |
| Text        | string       | Plain text                                           | \`"Bob"\`                      |
| Numeric     | number       | Floating point number                                | \`3.14\`                       |
| Int         | number       | Whole number                                         | \`42\`                         |
| Bool        | boolean      | \`true\` or \`false\`                                | \`false\`                      |
| Date        | number       | Unix timestamp in seconds                            | \`946771200\`                  |
| DateTime    | number       | Unix timestamp in seconds                            | \`1748890186\`                 |
| Choice      | string       | One of the allowed choices                           | \`"Active"\`                   |
| ChoiceList  | array        | List of allowed choices                              | \`["L", "Active", "Pending"]\` |
| Ref         | number       | ID of a record in the referenced table               | \`25\`                         |
| RefList     | array        | List of record IDs from the referenced table         | \`["L", 11, 12, 13]\`          |
| Attachments | array        | List of record IDs from the _grist_Attachments table | \`["L", 98, 99]\`              |
</modification_instructions>

<formula_instructions>
Use Grist-compatible Python syntax (e.g. \`$Amount * 1.1\`).
Prefer lookupOne and lookupRecords over manually enumerating records
(e.g., \`People.lookupOne(First_Name="Lewis", Last_Name="Carroll")\`, \`People.lookupRecords(Email=$Work_Email)\`).
Access fields in linked tables like: \`$Customer.Name\`, \`$Project.Owner.Email\`.
Date/DateTime columns are Python datetime objects.
</formula_instructions>

<examples>

<user_query>
What's the total sales by region?
</user_query>

<assistant_response>
Call query_document with:
\`\`\`sql
SELECT Region, SUM(Sales) FROM Orders GROUP BY Region
\`\`\`
</assistant_response>

<user_query>
Add a new project named 'Q4 Launch'.
</user_query>

<assistant_response>
Confirm with user, then call add_records with:
\`\`\`json
{
  "table_id": "Projects",
  "records": [{ "Name": "Q4 Launch" }]
}
\`\`\`
</assistant_response>

<user_query>
Delete all projects with status 'Archived'.
</user_query>

<assistant_response>
Call query_document with:
\`\`\`sql
SELECT id FROM Projects WHERE Status = 'Archived'
\`\`\`
Confirm with user, then call remove_records with:
\`\`\`json
{
  "table_id": "Projects",
  "record_ids": [1, 2, 3]
}
\`\`\`
</assistant_response>

</examples>

<context>
The current date is ${moment().format("MMMM D, YYYY")}.
${
  visibleTableIds && visibleTableIds.length > 0
    ? `The user is currently viewing table(s): ${visibleTableIds.join(", ")}.`
    : ""
}
</context>`;
    return {
      role: "system",
      content,
    };
  }

  private _getResponseFormat() {
    return {
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: true,
        schema: {
          type: "object",
          properties: {
            response_text: {
              type: "string",
            },
            confirmation_required: {
              type: "boolean",
            },
          },
          required: ["response_text", "confirmation_required"],
          additionalProperties: false,
        },
      },
    };
  }

  private _getTools(): OpenAITool[] {
    return [
      {
        type: "function",
        function: {
          name: "get_tables",
          description: "Returns the IDs of all tables in a Grist document.",
        },
      },
      {
        type: "function",
        function: {
          name: "add_table",
          description: "Adds a table to a Grist document.",
          parameters: {
            type: "object",
            properties: {
              table_id: {
                type: "string",
                description: "The ID of the table to add.",
              },
              columns: {
                type: ["array", "null"],
                description:
                  "The columns to create the table with. " +
                  "Null if the table should be created with default columns ('A', 'B', 'C').",
                items: {
                  type: "object",
                  properties: {
                    id: {
                      type: "string",
                      description: "The column ID.",
                    },
                  },
                  required: ["id"],
                  additionalProperties: false,
                },
              },
            },
            required: ["table_id", "columns"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      {
        type: "function",
        function: {
          name: "rename_table",
          description: "Renames a table in a Grist document.",
          parameters: {
            type: "object",
            properties: {
              table_id: {
                type: "string",
                description: "The ID of the table to rename.",
              },
              new_table_id: {
                type: "string",
                description: "The new ID of the table.",
              },
            },
            required: ["table_id", "new_table_id"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      {
        type: "function",
        function: {
          name: "remove_table",
          description: "Removes a table from a Grist document.",
          parameters: {
            type: "object",
            properties: {
              table_id: {
                type: "string",
                description: "The ID of the table to remove.",
              },
            },
            required: ["table_id"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      {
        type: "function",
        function: {
          name: "get_columns",
          description: "Returns all columns in a table.",
          parameters: {
            type: "object",
            properties: {
              table_id: {
                type: "string",
                description: "The ID of the table.",
              },
            },
            required: ["table_id"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      {
        type: "function",
        function: {
          name: "add_column",
          description: "Adds a column to a table.",
          parameters: {
            type: "object",
            properties: {
              table_id: {
                type: "string",
                description: "The ID of the table to add the column to.",
              },
              column_id: {
                type: "string",
                description: "The ID of the column to add.",
              },
              column_options: {
                type: ["object", "null"],
                description:
                  "The options to create the column with. " +
                  'Example: `{"type": "Text", "label": "Name"}`',
                properties: {
                  type: {
                    type: "string",
                    enum: [
                      "Any",
                      "Text",
                      "Numeric",
                      "Int",
                      "Bool",
                      "Date",
                      "DateTime",
                      "Choice",
                      "ChoiceList",
                      "Ref",
                      "RefList",
                      "Attachments",
                    ],
                    description: "The column type.",
                  },
                  reference_table_id: {
                    type: "string",
                    description:
                      "The ID of the referenced table. " +
                      "Required if type is Ref or RefList.",
                  },
                  label: {
                    type: "string",
                    description: "The column label.",
                  },
                  formula: {
                    type: ["string", "null"],
                    description:
                      "The column formula. " +
                      "Must be Grist-compatible Python syntax (e.g. `$Amount * 1.1`).",
                  },
                  formula_type: {
                    type: ["string", "null"],
                    enum: ["regular", "trigger"],
                    description:
                      "The formula type. " + "Required if formula is not null.",
                  },
                  untie_col_id_from_label: {
                    type: "boolean",
                    description:
                      "True if column ID should not be automatically changed to match label.",
                  },
                  description: {
                    type: "string",
                    description: "The column description.",
                  },
                  text_alignment: {
                    type: "string",
                    enum: ["left", "center", "right"],
                    description: "The column text alignment.",
                  },
                  text_wrap: {
                    type: "boolean",
                    description:
                      "True if text in the column should wrap to fit.",
                  },
                  choices: {
                    type: "array",
                    description:
                      "List of valid choices. " +
                      "Only applicable to Choice and ChoiceList columns.",
                    items: {
                      type: "string",
                    },
                  },
                  choice_styles: {
                    type: "object",
                    description:
                      "Optional styles for choices. " +
                      "Keys are valid choices (e.g., 'Name', 'Age'). " +
                      "Values are objects with keys: " +
                      "textColor, fillColor, fontUnderline, fontItalic, and fontStrikethrough. " +
                      "Colors must be in six-value hexadecimal syntax. " +
                      'Example: `{"Choice 1": {"textColor": "#FFFFFF", "fillColor": "#16B378", ' +
                      '"fontUnderline": false, "fontItalic": false, "fontStrikethrough": false}}`',
                  },
                },
                additionalProperties: false,
              },
            },
            required: ["table_id", "column_id", "column_options"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "update_column",
          description: "Updates a column in a table.",
          parameters: {
            type: "object",
            properties: {
              table_id: {
                type: "string",
                description: "The ID of the table containing the column.",
              },
              column_id: {
                type: "string",
                description: "The ID of the column to update.",
              },
              column_options: {
                type: "object",
                description:
                  "The column options to update. " +
                  "Only include fields to set/update. " +
                  'Example: `{"type": "Text", "label": "Name"}`',
                properties: {
                  id: {
                    type: "string",
                    description: "The column ID.",
                  },
                  type: {
                    type: "string",
                    enum: [
                      "Any",
                      "Text",
                      "Numeric",
                      "Int",
                      "Bool",
                      "Date",
                      "DateTime",
                      "Choice",
                      "ChoiceList",
                      "Ref",
                      "RefList",
                      "Attachments",
                    ],
                    description: "The column type.",
                  },
                  reference_table_id: {
                    type: "string",
                    description:
                      "The ID of the referenced table. " +
                      "Required if type is Ref or RefList.",
                  },
                  label: {
                    type: "string",
                    description: "The column label.",
                  },
                  formula: {
                    type: ["string", "null"],
                    description:
                      "The column formula. " +
                      "Must be Grist-compatible Python syntax (e.g. `$Amount * 1.1`).",
                  },
                  formula_type: {
                    type: ["string", "null"],
                    enum: ["regular", "trigger"],
                    description:
                      "The formula type. " + "Required if formula is not null.",
                  },
                  untie_col_id_from_label: {
                    type: "boolean",
                    description:
                      "True if column ID should not be automatically changed to match label.",
                  },
                  description: {
                    type: "string",
                    description: "The column description.",
                  },
                  text_alignment: {
                    type: "string",
                    enum: ["left", "center", "right"],
                    description: "The column text alignment.",
                  },
                  text_wrap: {
                    type: "boolean",
                    description:
                      "True if text in the column should wrap to fit.",
                  },
                  choices: {
                    type: "array",
                    description:
                      "List of valid choices. " +
                      "Only applicable to Choice and ChoiceList columns.",
                    items: {
                      type: "string",
                    },
                  },
                  choice_styles: {
                    type: "object",
                    description:
                      "Optional styles for choices. " +
                      "Keys are valid choices (e.g., 'Name', 'Age'). " +
                      "Values are objects with keys: " +
                      "textColor, fillColor, fontUnderline, fontItalic, and fontStrikethrough. " +
                      "Colors must be in six-value hexadecimal syntax. " +
                      'Example: `{"Choice 1": {"textColor": "#FFFFFF", "fillColor": "#16B378", ' +
                      '"fontUnderline": false, "fontItalic": false, "fontStrikethrough": false}}`',
                  },
                },
                additionalProperties: false,
              },
            },
            required: ["table_id", "column_id", "column_options"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "remove_column",
          description: "Removes a column from a table.",
          parameters: {
            type: "object",
            properties: {
              table_id: {
                type: "string",
                description: "The ID of the table containing the column.",
              },
              column_id: {
                type: "string",
                description: "The ID of the column to remove.",
              },
            },
            required: ["table_id", "column_id"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      {
        type: "function",
        function: {
          name: "query_document",
          description:
            "Runs a SQL SELECT query against a Grist document and returns matching rows. " +
            "Only SQLite-compatible SQL is supported.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "A SQL SELECT query to run on the Grist document. " +
                  "Must be a single SELECT statement with no trailing semicolon. " +
                  "WITH clauses are permitted. " +
                  "Must be valid SQLite syntax.",
              },
              args: {
                type: ["array", "null"],
                description:
                  "Arguments for parameters in query. " +
                  "Null if query is not parameterized.",
                items: {
                  type: ["string", "number", "boolean", "null"],
                },
              },
            },
            required: ["query", "args"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      {
        type: "function",
        function: {
          name: "add_records",
          description: "Adds one or more records to a table.",
          parameters: {
            type: "object",
            properties: {
              table_id: {
                type: "string",
                description: "The ID of the table to add the records to.",
              },
              records: {
                type: "array",
                description: "The records to add.",
                items: {
                  type: "object",
                  description:
                    "A record. Keys are column IDs (e.g., 'Name', 'Age'). " +
                    'Example: `{"Name": "Alice", "Age": 30}`',
                },
              },
            },
            required: ["table_id", "records"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "update_records",
          description: "Updates one or more records in a table.",
          parameters: {
            type: "object",
            properties: {
              table_id: {
                type: "string",
                description: "The ID of the table to update the records in.",
              },
              record_ids: {
                type: "array",
                description: "The IDs of the records to update.",
                items: {
                  type: "number",
                },
              },
              records: {
                type: "array",
                description:
                  "The records to update, in the same order as record_ids.",
                items: {
                  description:
                    "A record. Keys are column IDs (e.g., 'Name', 'Age'). " +
                    'Example: `{"Name": "Alice", "Age": 30}`',
                },
              },
            },
            required: ["table_id", "record_ids", "records"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "remove_records",
          description: "Removes one or more records from a table.",
          parameters: {
            type: "object",
            properties: {
              table_id: {
                type: "string",
                description: "The ID of the table to remove the records from.",
              },
              record_ids: {
                type: "array",
                description: "The IDs of the records to remove.",
                items: {
                  type: "number",
                },
              },
            },
            required: ["table_id", "record_ids"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    ];
  }

  private async _handleToolCalls(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    request: AssistanceRequestV2,
    completion: OpenAIChatCompletion
  ) {
    const {
      choice: { message },
      state,
    } = completion;
    const toolCallIdsAndResults: [string, FunctionCallResult][] = [];
    for (const call of message.tool_calls ?? []) {
      const {
        id,
        function: { name, arguments: args },
      } = call;
      const result = await this._callFunction(
        docSession,
        doc,
        name,
        JSON.parse(args)
      );
      toolCallIdsAndResults.push([id, result]);
    }
    request = {
      conversationId: request.conversationId,
      context: request.context,
      state: {
        messages: [
          ...(state.messages ?? []),
          ...toolCallIdsAndResults.map(([tool_call_id, result]) => {
            return {
              role: "tool" as const,
              tool_call_id,
              content: JSON.stringify(result),
            };
          }),
        ],
      },
    };
    const results = toolCallIdsAndResults.map(([_id, result]) => result);
    const successResults = results.filter(
      (result): result is FunctionCallSuccess => result.ok
    );
    const modifications = successResults.filter(
      (result) => result.result.isModification
    );
    const appliedActions: ApplyUAResult[] = modifications
      .map((m) => m.result)
      .flat(1);
    return {
      completion: await this._getCompletion(docSession, doc, request),
      appliedActions,
    };
  }

  private async _callFunction(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    name: string,
    parameterArgs?: any
  ): Promise<FunctionCallResult> {
    try {
      let result: any;
      switch (name) {
        case "get_tables": {
          result = this._getTables(doc);
          break;
        }
        case "add_table": {
          const tableId = stringParam(parameterArgs.table_id, "table_id");
          const { columns } = parameterArgs;
          result = await this._addTable(
            docSession,
            doc,
            tableId,
            columns ?? []
          );
          break;
        }
        case "rename_table": {
          const tableId = stringParam(parameterArgs.table_id, "table_id");
          const newTableId = stringParam(
            parameterArgs.new_table_id,
            "new_table_id"
          );
          result = await this._renameTable(
            docSession,
            doc,
            tableId,
            newTableId
          );
          break;
        }
        case "remove_table": {
          const tableId = stringParam(parameterArgs.table_id, "table_id");
          result = await this._removeTable(docSession, doc, tableId);
          break;
        }
        case "get_columns": {
          const tableId = stringParam(parameterArgs.table_id, "table_id");
          result = await doc.getTableCols(docSession, tableId);
          break;
        }
        case "add_column": {
          const tableId = stringParam(parameterArgs.table_id, "table_id");
          const columnId = stringParam(parameterArgs.column_id, "column_id");
          const { column_options: columnOptions } = parameterArgs;
          result = await this._addColumn(
            docSession,
            doc,
            tableId,
            columnId,
            columnOptions
          );
          break;
        }
        case "update_column": {
          const tableId = stringParam(parameterArgs.table_id, "table_id");
          const columnId = stringParam(parameterArgs.column_id, "column_id");
          const { column_options: columnOptions } = parameterArgs;
          if (columnOptions === null) {
            throw new Error("column_options parameter is required");
          }

          result = await this._updateColumn(
            docSession,
            doc,
            tableId,
            columnId,
            columnOptions
          );
          break;
        }
        case "remove_column": {
          const tableId = stringParam(parameterArgs.table_id, "table_id");
          const columnId = stringParam(parameterArgs.column_id, "column_id");
          result = await this._removeColumn(docSession, doc, tableId, columnId);
          break;
        }
        case "query_document": {
          const query = stringParam(parameterArgs.query, "query");
          const args = parameterArgs.args;
          result = await runSQLQuery(docSession, doc, {
            sql: query,
            args,
          });
          break;
        }
        case "add_records": {
          const tableId = stringParam(parameterArgs.table_id, "table_id");
          const records = parameterArgs.records;
          if (!records) {
            throw new Error("records parameter is required");
          }

          result = await this._addRecords(docSession, doc, tableId, records);
          break;
        }
        case "update_records": {
          const tableId = stringParam(parameterArgs.table_id, "table_id");
          const records = parameterArgs.records;
          const recordIds = parameterArgs.record_ids;
          if (!records) {
            throw new Error("records parameter is required");
          }
          if (!recordIds) {
            throw new Error("record_ids parameter is required");
          }

          result = await this._updateRecords(
            docSession,
            doc,
            tableId,
            recordIds,
            records
          );
          break;
        }
        case "remove_records": {
          const tableId = stringParam(parameterArgs.table_id, "table_id");
          const recordIds = parameterArgs.record_ids;
          if (!recordIds) {
            throw new Error("record_ids parameter is required");
          }

          result = await this._removeRecords(
            docSession,
            doc,
            tableId,
            recordIds
          );
          break;
        }
        default: {
          throw new Error(`Unrecognized function: ${name}`);
        }
      }
      return { ok: true, result };
    } catch (e) {
      return {
        ok: false,
        error: String(e),
      };
    }
  }

  private _getTables(doc: AssistanceDoc) {
    const docData = doc.docData;
    if (!docData) {
      throw new Error("Document not ready");
    }

    const tables = docData
      .getMetaTable("_grist_Tables")
      .getRecords()
      .filter((r) => r.tableId && !r.tableId.startsWith("GristHidden_"));
    return tables ?? [];
  }

  private async _addTable(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    tableId: string,
    columns: any[]
  ) {
    return await handleSandboxError(
      tableId,
      [],
      doc.applyUserActions(docSession, [["AddTable", tableId, columns]], {
        desc: "Called by OpenAIAssistantV2 (tool: add_table)",
      })
    );
  }

  private async _renameTable(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    tableId: string,
    newTableId: string
  ) {
    return await handleSandboxError(
      tableId,
      [],
      doc.applyUserActions(docSession, [["RenameTable", tableId, newTableId]], {
        desc: "Called by OpenAIAssistantV2 (tool: rename_table)",
      })
    );
  }

  private async _removeTable(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    tableId: string
  ) {
    return await handleSandboxError(
      tableId,
      [],
      doc.applyUserActions(docSession, [["RemoveTable", tableId]], {
        desc: "Called by OpenAIAssistantV2 (tool: remove_table)",
      })
    );
  }

  private async _addColumn(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    tableId: string,
    columnId: string,
    columnOptions: any
  ) {
    const colInfo = toColInfo(doc, tableId, columnOptions ?? {});
    return await handleSandboxError(
      tableId,
      [columnId],
      doc.applyUserActions(
        docSession,
        [["AddVisibleColumn", tableId, columnId, colInfo]],
        {
          desc: "Called by OpenAIAssistantV2 (tool: add_column)",
        }
      )
    );
  }

  private async _updateColumn(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    tableId: string,
    columnId: string,
    columnOptions: any
  ) {
    const colInfo = toColInfo(doc, tableId, columnOptions);
    if (colInfo.widgetOptions !== undefined) {
      const columns = await doc.getTableCols(docSession, tableId);
      const column = columns.find((c) => c.id === columnId);
      if (!column) {
        throw new Error(`Column ${columnId} not found`);
      }

      const originalWidgetOptions = safeJsonParse(
        column.fields["widgetOptions"] as any,
        {}
      );
      const newWidgetOptions = safeJsonParse(colInfo.widgetOptions, {});
      colInfo.widgetOptions = JSON.stringify({
        ...originalWidgetOptions,
        ...newWidgetOptions,
      });
    }
    return await handleSandboxError(
      tableId,
      [columnId],
      doc.applyUserActions(
        docSession,
        [["ModifyColumn", tableId, columnId, colInfo]],
        {
          desc: "Called by OpenAIAssistantV2 (tool: update_column)",
        }
      )
    );
  }

  private async _removeColumn(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    tableId: string,
    columnId: string
  ) {
    return await handleSandboxError(
      tableId,
      [columnId],
      doc.applyUserActions(docSession, [["RemoveColumn", tableId, columnId]], {
        desc: "Called by OpenAIAssistantV2 (tool: remove_column)",
      })
    );
  }

  private async _addRecords(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    tableId: string,
    records: Partial<RowRecord>[]
  ) {
    return await handleSandboxError(
      tableId,
      [],
      doc.applyUserActions(
        docSession,
        [
          [
            "BulkAddRecord",
            tableId,
            arrayRepeat(records.length, null),
            getColValues(records),
          ],
        ],
        {
          desc: "Called by OpenAIAssistantV2 (tool: add_records)",
          parseStrings: true,
        }
      )
    );
  }

  private async _updateRecords(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    tableId: string,
    recordIds: number[],
    records: Partial<RowRecord>[]
  ) {
    return await handleSandboxError(
      tableId,
      [],
      doc.applyUserActions(
        docSession,
        [["BulkUpdateRecord", tableId, recordIds, getColValues(records)]],
        {
          desc: "Called by OpenAIAssistantV2 (tool: update_records)",
          parseStrings: true,
        }
      )
    );
  }

  private async _removeRecords(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    tableId: string,
    recordIds: number[]
  ) {
    return await handleSandboxError(
      tableId,
      [],
      doc.applyUserActions(
        docSession,
        [["BulkRemoveRecord", tableId, recordIds]],
        {
          desc: "Called by OpenAIAssistantV2 (tool: remove_records)",
        }
      )
    );
  }

  private _buildResponse(
    completion: OpenAIChatCompletion,
    appliedActions?: ApplyUAResult[]
  ): AssistanceResponseV2 {
    const { message } = completion.choice;
    const { refusal } = message;
    if (refusal) {
      return {
        reply: refusal,
        state: completion.state,
        appliedActions,
        confirmationRequired: false,
      };
    }

    let rawContent = message.content;
    if (typeof rawContent !== "string" || rawContent.trim() === "") {
      throw new Error("Expected non-empty content in response");
    }

    // Structured output is a little buggy in GPT-4o.
    // Sometimes it appends a newline to the content and repeats it.
    rawContent = rawContent.split("\n")[0].trim();
    let parsedContent: any;
    try {
      parsedContent = JSON.parse(rawContent);
    } catch (e) {
      throw new Error(`Failed to parse content as JSON: "${rawContent}"`, {
        cause: e,
      });
    }

    if (typeof parsedContent.response_text !== "string") {
      throw new Error(
        "Parsed content is missing required field: response_text"
      );
    }

    return {
      reply: parsedContent.response_text,
      state: completion.state,
      appliedActions,
      confirmationRequired: parsedContent.confirmation_required,
    };
  }
}

export class EchoAssistantV2 implements AssistantV2 {
  public static readonly VERSION = 2;

  public async getAssistance(
    _docSession: OptDocSession,
    _doc: AssistanceDoc,
    request: AssistanceRequestV2
  ): Promise<AssistanceResponseV2> {
    if (request.text === "ERROR") {
      throw new Error("ERROR");
    }

    const messages = request.state?.messages || [];
    if (messages.length === 0) {
      messages.push({
        role: "system",
        content: "",
      });
    }
    messages.push({
      role: "user",
      content: request.text,
    });
    const completion = request.text ?? "";
    const history = { messages };
    history.messages.push({
      role: "assistant",
      content: completion,
    });
    return {
      reply: completion,
      state: history,
    };
  }

  public get version(): AssistantV2["version"] {
    return EchoAssistantV2.VERSION;
  }

  public get provider(): AssistantProvider {
    return null;
  }
}

async function getVisibleTableIds(
  docSession: OptDocSession,
  doc: AssistanceDoc,
  viewId: number
) {
  const metaTables = await doc.fetchMetaTables(docSession);
  const allViewSections = metaTables["_grist_Views_section"];
  let [, , ids, vals] = allViewSections;
  const viewSections = ids
    .map((id, idx) => {
      return {
        id,
        parentId: vals["parentId"][idx],
        tableRef: vals["tableRef"][idx],
      };
    })
    .filter((vs) => vs.parentId === viewId);

  const allTables = metaTables["_grist_Tables"];
  [, , ids, vals] = allTables;
  const tablesByRef: Record<number, { id: number; tableId: CellValue }> = {};
  ids.forEach((id, idx) => {
    tablesByRef[id] = {
      id,
      tableId: vals["tableId"][idx],
    };
  });

  return [
    ...new Set(
      viewSections
        .map((vs) => tablesByRef[vs.parentId as number]?.tableId)
        .filter((tableId) => tableId !== undefined)
    ),
  ];
}

function toColInfo(
  doc: AssistanceDoc,
  tableId: string,
  columnOptions: any
): Partial<any> {
  const colInfo: any = pick(
    columnOptions,
    "type",
    "label",
    "formula",
    "description"
  );
  if (columnOptions.id) {
    colInfo.colId = columnOptions.id;
  }
  if (colInfo.type === "DateTime") {
    colInfo.type += `:${doc.docData?.docInfo().timezone ?? "UTC"}`;
  } else if (colInfo.type?.startsWith("Ref")) {
    colInfo.type += `:${columnOptions.reference_table_id ?? tableId}`;
  }
  if (columnOptions.formula_type !== undefined) {
    colInfo.isFormula = columnOptions.formula_type === "regular";
  }
  if (colInfo.formula !== undefined && !colInfo.formula) {
    colInfo.isFormula = false;
  }
  if (columnOptions.untie_col_id_from_label !== undefined) {
    colInfo.untieColIdFromLabel = columnOptions.untie_col_id_from_label;
  }
  if (columnOptions.text_alignment !== undefined) {
    colInfo.widgetOptions = {
      ...colInfo.widgetOptions,
      alignment: columnOptions.text_alignment,
    };
  }
  if (columnOptions.text_wrap !== undefined) {
    colInfo.widgetOptions = {
      ...colInfo.widgetOptions,
      wrap: columnOptions.text_wrap,
    };
  }
  if (columnOptions.choices !== undefined) {
    colInfo.widgetOptions = {
      ...colInfo.widgetOptions,
      choices: columnOptions.choices,
    };
  }
  if (columnOptions.choice_styles !== undefined) {
    colInfo.widgetOptions = {
      ...colInfo.widgetOptions,
      choiceOptions: columnOptions.choice_styles,
    };
  }
  if (colInfo.widgetOptions !== undefined) {
    colInfo.widgetOptions = JSON.stringify(colInfo.widgetOptions);
  }
  return colInfo;
}

async function handleSandboxError<T>(
  tableId: string,
  colNames: string[],
  p: Promise<T>
): Promise<T> {
  return handleSandboxErrorOnPlatform(
    tableId,
    colNames,
    p,
    getErrorPlatform(tableId)
  );
}

function getErrorPlatform(tableId: string): TableOperationsPlatform {
  return {
    throwError(_, text) {
      throw new Error(text);
    },
    // The methods below are not used, but are required by the interface.
    // TODO: decouple handleSandboxErrorOnPlatform from TableOperationsPlatform.
    async getTableId() {
      return tableId;
    },
    applyUserActions() {
      throw new Error("no document");
    },
  };
}
