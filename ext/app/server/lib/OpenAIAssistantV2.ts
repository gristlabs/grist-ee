import { ApplyUAResult } from "app/common/ActiveDocAPI";
import {
  AssistanceMessage,
  AssistanceRequestV2,
  AssistanceResponseV2,
} from "app/common/Assistance";
import { AssistantProvider } from "app/common/Assistant";
import { delay } from "app/common/delay";
import {
  CellValue,
  getColValues,
  RowRecord,
  UserAction,
} from "app/common/DocActions";
import { getReferencedTableId, RecalcWhen } from "app/common/gristTypes";
import { safeJsonParse } from "app/common/gutil";
import { RecordWithStringId } from "app/plugin/DocApiTypes";
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
import { isEmpty, pick } from "lodash";
import moment from "moment";
import fetch from "node-fetch";

export const DEPS = { fetch, delayTime: 1000 };

// TODO: move this to a common location.
// Perhaps merge it with the one in DocData.ts?
interface ColInfo {
  colId: string;
  type: string;
  label: string;
  isFormula: boolean;
  formula: string;
  description: string;
  recalcDeps: number[] | null;
  recalcWhen: RecalcWhen;
  visibleCol: number;
  untieColIdFromLabel: boolean;
  widgetOptions: string;
}

// TODO: use ts-interface-checker or Zod to generate and enforce these types.
interface AddColumnOptions {
  id?: string;
  type?: string;
  label?: string;
  formula?: string;
  description?: string;
  formula_type?: "regular" | "trigger";
  untie_col_id_from_label?: boolean;
  text_format?: "text" | "markdown" | "hyperlink";
  number_show_spinner?: boolean;
  number_format?: "text" | "currency" | "decimal" | "percent" | "scientific";
  number_currency_code?: string | null;
  number_minus_sign?: "minus" | "parens";
  number_min_decimals?: number;
  number_max_decimals?: number;
  toggle_format?: "text" | "checkbox" | "switch";
  reference_table_id?: string;
  date_format?:
    | "YYYY-MM-DD"
    | "MM-DD-YYYY"
    | "MM/DD/YYYY"
    | "MM-DD-YY"
    | "MM/DD/YY"
    | "DD MMM YYYY"
    | "MMMM Do, YYYY"
    | "DD-MM-YYYY"
    | "custom";
  date_custom_format?: string;
  time_format?:
    | "h:mma"
    | "h:mma z"
    | "HH:mm"
    | "HH:mm z"
    | "HH:mm:ss"
    | "HH:mm:ss z"
    | "custom";
  time_custom_format?: string;
  timezone?: string;
  attachment_height?: number;
  choices?: string[];
  choice_styles?: Record<string, any>;
  cell_text_color?: string;
  cell_fill_color?: string;
  cell_bold?: boolean;
  cell_underline?: boolean;
  cell_italic?: boolean;
  cell_strikethrough?: boolean;
  header_text_color?: string;
  header_fill_color?: string;
  header_bold?: boolean;
  header_underline?: boolean;
  header_italic?: boolean;
  header_strikethrough?: boolean;
  text_alignment?: "left" | "center" | "right";
  text_wrap?: boolean;
  conditional_formatting_rules?: unknown[];
}

interface UpdateColumnOptions extends AddColumnOptions {
  reference_show_column_id?: string;
  formula_recalc_behavior?:
    | "add-record"
    | "add-or-update-record"
    | "custom"
    | "never";
  formula_recalc_col_ids?: string[];
}

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
        response: {
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
    const start = oldMessages.length > 0 ? oldMessages.length - 1 : 0;
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
conditional_formatting_rules is not yet supported. Tell users to
configure it manually from the creator panel, below "Cell Style".
Use values appropriate for each column's type (see table below).
Prefix lists with an "L" element (e.g., \`["L", 1, 2, 3]\`).

| Column Type | Value Format | Description                                          | Examples                       |
|-------------|--------------|------------------------------------------------------|--------------------------------|
| Any         | any          | Any value                                            | \`"Alice"\`, \`123\`, \`true\` |
| Text        | string       | Plain text                                           | \`"Bob"\`                      |
| Numeric     | number       | Floating point number                                | \`3.14\`                       |
| Int         | number       | Whole number                                         | \`42\`, \`3.0\`                |
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
                  text_format: {
                    type: "string",
                    enum: ["text", "markdown", "hyperlink"],
                    description:
                      "The format of Text columns. " +
                      "If unset, defaults to text.",
                  },
                  number_show_spinner: {
                    type: "boolean",
                    description:
                      "Whether to show increment/decrement buttons. " +
                      "If unset, defaults to false.",
                  },
                  number_format: {
                    type: "string",
                    enum: [
                      "text",
                      "currency",
                      "decimal",
                      "percent",
                      "scientific",
                    ],
                    description:
                      "The format of Int and Numeric columns. " +
                      "If unset, defaults to text.",
                  },
                  number_currency_code: {
                    type: ["string", "null"],
                    description:
                      "ISO 4217 currency code (e.g. 'USD', 'GBP', 'JPY'). " +
                      "Uses the document's currency if null or unset. " +
                      "Only applies if number_format is currency.",
                  },
                  number_minus_sign: {
                    type: "string",
                    enum: ["minus", "parens"],
                    description:
                      "How to format negative numbers. " +
                      "If unset, defaults to minus.",
                  },
                  number_min_decimals: {
                    type: "number",
                    description:
                      "Minimum number of decimals for Int and Numeric columns.",
                    minimum: 0,
                    maximum: 20,
                  },
                  number_max_decimals: {
                    type: "number",
                    description:
                      "Maximum number of decimals for Int and Numeric columns.",
                    minimum: 0,
                    maximum: 20,
                  },
                  toggle_format: {
                    type: "string",
                    enum: ["text", "checkbox", "switch"],
                    description:
                      "The format of Bool/Toggle columns. " +
                      "If unset, defaults to checkbox.",
                  },
                  reference_table_id: {
                    type: "string",
                    description:
                      "The ID of the referenced table. " +
                      "Required if type is Ref or RefList.",
                  },
                  date_format: {
                    type: "string",
                    enum: [
                      "YYYY-MM-DD",
                      "MM-DD-YYYY",
                      "MM/DD/YYYY",
                      "MM-DD-YY",
                      "MM/DD/YY",
                      "DD MMM YYYY",
                      "MMMM Do, YYYY",
                      "DD-MM-YYYY",
                      "custom",
                    ],
                    description:
                      "The date format of Date and DateTime columns. " +
                      "If custom, date_custom_format must be set.",
                  },
                  date_custom_format: {
                    type: "string",
                    description:
                      "A Moment.js date format string (e.g. 'ddd, hA'). " +
                      "Only applied if date_format is custom.",
                  },
                  time_format: {
                    type: "string",
                    enum: [
                      "h:mma",
                      "h:mma z",
                      "HH:mm",
                      "HH:mm z",
                      "HH:mm:ss",
                      "HH:mm:ss z",
                      "custom",
                    ],
                    description:
                      "The time format of DateTime columns. " +
                      "If custom, time_custom_format must be set.",
                  },
                  time_custom_format: {
                    type: "string",
                    description:
                      "A Moment.js time format string (e.g. 'h:mm a'). " +
                      "Only applied if time_format is custom.",
                  },
                  timezone: {
                    type: "string",
                    description:
                      "The IANA TZ identifier (e.g. 'America/New_York') for DateTime columns. " +
                      "If unset, the document's timezone will be used.",
                  },
                  attachment_height: {
                    type: "number",
                    description: "Height of attachment thumbnails in pixels. ",
                    minimum: 16,
                    maximum: 96,
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
                      "The formula type. " +
                      "Regular formulas always recalculate whenever the document is loaded or modified. " +
                      "Trigger formulas only recalculate according to formula_recalc_behavior. " +
                      "Required if formula is not null.",
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
                  cell_text_color: {
                    type: "string",
                    description:
                      "The cell text color. " +
                      "Must be a six-value hexadecimal string. " +
                      'Example: `"#FFFFFF"`',
                  },
                  cell_fill_color: {
                    type: "string",
                    description:
                      "The cell fill color. " +
                      "Must be a six-value hexadecimal string. " +
                      'Example: `"#16B378"`',
                  },
                  cell_bold: {
                    type: "boolean",
                    description: "If cell text should be bolded.",
                  },
                  cell_underline: {
                    type: "boolean",
                    description: "If cell text should be underlined.",
                  },
                  cell_italic: {
                    type: "boolean",
                    description: "If cell text should be italicized.",
                  },
                  cell_strikethrough: {
                    type: "boolean",
                    description:
                      "If cell text should have a horizontal line through the center.",
                  },
                  header_text_color: {
                    type: "string",
                    description:
                      "The column header text color. " +
                      "Must be a six-value hexadecimal string. " +
                      'Example: `"#FFFFFF"`',
                  },
                  header_fill_color: {
                    type: "string",
                    description:
                      "The column header fill color. " +
                      "Must be a six-value hexadecimal string. " +
                      'Example: `"#16B378"`',
                  },
                  header_bold: {
                    type: "boolean",
                    description: "If the header text should be bolded.",
                  },
                  header_underline: {
                    type: "boolean",
                    description: "If the header text should be underlined.",
                  },
                  header_italic: {
                    type: "boolean",
                    description: "If the header text should be italicized.",
                  },
                  header_strikethrough: {
                    type: "boolean",
                    description:
                      "If the header text should have a horizontal line through the center.",
                  },
                  conditional_formatting_rules: {
                    description:
                      "Not yet supported. Must be configured manually in the creator panel.",
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
                  text_format: {
                    type: "string",
                    enum: ["text", "markdown", "hyperlink"],
                    description:
                      "The format of Text columns. " +
                      "If unset, defaults to text.",
                  },
                  number_show_spinner: {
                    type: "boolean",
                    description:
                      "Whether to show increment/decrement buttons. " +
                      "If unset, defaults to false.",
                  },
                  number_format: {
                    type: "string",
                    enum: [
                      "text",
                      "currency",
                      "decimal",
                      "percent",
                      "scientific",
                    ],
                    description:
                      "The format of Int and Numeric columns. " +
                      "If unset, defaults to text.",
                  },
                  number_currency_code: {
                    type: "string",
                    description:
                      "ISO 4217 currency code (e.g. 'USD', 'GBP', 'JPY'). " +
                      "Uses the document's currency if null or unset. " +
                      "Only applies if number_format is currency.",
                  },
                  number_minus_sign: {
                    type: "string",
                    enum: ["minus", "parens"],
                    description:
                      "How to format negative numbers. " +
                      "If unset, defaults to minus.",
                  },
                  number_min_decimals: {
                    type: "number",
                    description:
                      "Minimum number of decimals for Int and Numeric columns.",
                    minimum: 0,
                    maximum: 20,
                  },
                  number_max_decimals: {
                    type: "number",
                    description:
                      "Maximum number of decimals for Int and Numeric columns.",
                    minimum: 0,
                    maximum: 20,
                  },
                  toggle_format: {
                    type: "string",
                    enum: ["text", "checkbox", "switch"],
                    description:
                      "The format of Bool/Toggle columns. " +
                      "If unset, defaults to checkbox.",
                  },
                  reference_table_id: {
                    type: "string",
                    description:
                      "The ID of the referenced table. " +
                      "Required if type is Ref or RefList.",
                  },
                  reference_show_column_id: {
                    type: "string",
                    description:
                      "The ID of the column from the referenced table to show. " +
                      "Required if type is Ref or RefList.",
                  },
                  date_format: {
                    type: "string",
                    enum: [
                      "YYYY-MM-DD",
                      "MM-DD-YYYY",
                      "MM/DD/YYYY",
                      "MM-DD-YY",
                      "MM/DD/YY",
                      "DD MMM YYYY",
                      "MMMM Do, YYYY",
                      "DD-MM-YYYY",
                      "custom",
                    ],
                    description:
                      "The date format of Date and DateTime columns. " +
                      "If custom, date_custom_format must be set.",
                  },
                  date_custom_format: {
                    type: "string",
                    description:
                      "A Moment.js date format string (e.g. 'ddd, hA'). " +
                      "Only applied if date_format is custom.",
                  },
                  time_format: {
                    type: "string",
                    enum: [
                      "h:mma",
                      "h:mma z",
                      "HH:mm",
                      "HH:mm z",
                      "HH:mm:ss",
                      "HH:mm:ss z",
                      "custom",
                    ],
                    description:
                      "The time format of DateTime columns. " +
                      "If custom, time_custom_format must be set.",
                  },
                  time_custom_format: {
                    type: "string",
                    description:
                      "A Moment.js time format string (e.g. 'h:mm a'). " +
                      "Only applied if time_format is custom.",
                  },
                  timezone: {
                    type: "string",
                    description:
                      "The IANA TZ identifier (e.g. 'America/New_York') for DateTime columns. " +
                      "If unset, the document's timezone will be used.",
                  },
                  attachment_height: {
                    type: "number",
                    description: "Height of attachment thumbnails in pixels. ",
                    minimum: 16,
                    maximum: 96,
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
                      "The formula type. " +
                      "Regular formulas always recalculate whenever the document is loaded or data is changed. " +
                      "Trigger formulas only recalculate according to formula_recalc_behavior. " +
                      "Required if formula is not null.",
                  },
                  formula_recalc_behavior: {
                    type: "string",
                    enum: [
                      "add-record",
                      "add-or-update-record",
                      "custom",
                      "never",
                    ],
                    description:
                      "When to recalculate the trigger formula. " +
                      "add-record only calculates the formula when a record is first added. " +
                      "add-or-update-record also recalculates the formula whenever a record updated. " +
                      "custom only recalculates the formula whenever a record is added or " +
                      "a column in formula_recalc_col_ids is updated.",
                  },
                  formula_recalc_col_ids: {
                    type: "array",
                    description:
                      "If any of these columns change, the formula will be recalculated. " +
                      "Required if formula_recalc_behavior is custom.",
                    items: {
                      type: "string",
                    },
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
                  cell_text_color: {
                    type: "string",
                    description:
                      "The cell text color. " +
                      "Must be a six-value hexadecimal string. " +
                      'Example: `"#FFFFFF"`',
                  },
                  cell_fill_color: {
                    type: "string",
                    description:
                      "The cell fill color. " +
                      "Must be a six-value hexadecimal string. " +
                      'Example: `"#16B378"`',
                  },
                  cell_bold: {
                    type: "boolean",
                    description: "If cell text should be bolded.",
                  },
                  cell_underline: {
                    type: "boolean",
                    description: "If cell text should be underlined.",
                  },
                  cell_italic: {
                    type: "boolean",
                    description: "If cell text should be italicized.",
                  },
                  cell_strikethrough: {
                    type: "boolean",
                    description:
                      "If cell text should have a horizontal line through the center.",
                  },
                  header_text_color: {
                    type: "string",
                    description:
                      "The column header text color. " +
                      "Must be a six-value hexadecimal string. " +
                      'Example: `"#FFFFFF"`',
                  },
                  header_fill_color: {
                    type: "string",
                    description:
                      "The column header fill color. " +
                      "Must be a six-value hexadecimal string. " +
                      'Example: `"#16B378"`',
                  },
                  header_bold: {
                    type: "boolean",
                    description: "If the header text should be bolded.",
                  },
                  header_underline: {
                    type: "boolean",
                    description: "If the header text should be underlined.",
                  },
                  header_italic: {
                    type: "boolean",
                    description: "If the header text should be italicized.",
                  },
                  header_strikethrough: {
                    type: "boolean",
                    description:
                      "If the header text should have a horizontal line through the center.",
                  },
                  conditional_formatting_rules: {
                    description:
                      "Not yet supported. Must be configured manually in the creator panel.",
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
          result = await this._addTable(docSession, doc, tableId, columns);
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
          const { column_options: options } = parameterArgs;
          result = await this._addColumn(
            docSession,
            doc,
            tableId,
            columnId,
            options
          );
          break;
        }
        case "update_column": {
          const tableId = stringParam(parameterArgs.table_id, "table_id");
          const columnId = stringParam(parameterArgs.column_id, "column_id");
          const { column_options: options } = parameterArgs;
          if (options === null) {
            throw new Error("column_options parameter is required");
          }

          result = await this._updateColumn(
            docSession,
            doc,
            tableId,
            columnId,
            options
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

  private _getTables(doc: AssistanceDoc): string[] {
    const docData = doc.docData;
    if (!docData) {
      throw new Error("Document not ready");
    }

    const tables = docData
      .getMetaTable("_grist_Tables")
      .getColValues("tableId")
      .filter((tableId) => tableId && !tableId.startsWith("GristHidden_"));
    return tables;
  }

  private async _addTable(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    tableId: string,
    columns: any[]
  ) {
    const actions: UserAction[] = [];
    if (!columns || columns.length === 0) {
      // AddEmptyTable includes default columns ('A', 'B', 'C'), unlike
      // AddTable, which creates a table with no columns that appears broken
      // in the UI.
      actions.push(["AddEmptyTable", tableId]);
    } else {
      actions.push(["AddTable", tableId, columns]);
    }
    return await handleSandboxError(
      tableId,
      [],
      doc.applyUserActions(docSession, actions, {
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
    options: AddColumnOptions
  ) {
    const colInfo = options ? buildColInfo(doc, null, options) : {};
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
    options: UpdateColumnOptions
  ) {
    const columns = await doc.getTableCols(docSession, tableId);
    const column = columns.find((c) => c.id === columnId);
    if (!column) {
      throw new Error(`Column ${columnId} not found`);
    }

    const colInfo = buildColInfo(doc, column, options);
    const actions: UserAction[] = [
      ["ModifyColumn", tableId, columnId, colInfo],
    ];
    if (colInfo.visibleCol) {
      // TODO: also set visibleCol in create_column.
      //
      // SetDisplayFormula requires:
      //  1. The row ID of the added column
      //  2. The final table ID of the added column
      //
      // Ideally, the action should be applied in the same bundle as
      // AddVisibleColumn, to maintain atomicity. This may require
      // modifications to AddVisibleColumn, since the final table ID
      // isn't known ahead of time.
      actions.push([
        "SetDisplayFormula",
        tableId,
        null,
        column.fields["colRef"],
        `$${column.id}.${options.reference_show_column_id}`,
      ]);
    }
    return await handleSandboxError(
      tableId,
      [columnId],
      doc.applyUserActions(docSession, actions, {
        desc: "Called by OpenAIAssistantV2 (tool: update_column)",
      })
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
    if (request.text === "SLOW") {
      await new Promise(r => setTimeout(r, 1000));
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

function buildColInfo(
  doc: AssistanceDoc,
  column: RecordWithStringId | null,
  options: AddColumnOptions | UpdateColumnOptions
): Partial<ColInfo> {
  const colInfo: Partial<ColInfo> = pick(
    options,
    "type",
    "label",
    "formula",
    "description"
  );

  if (options.id) {
    colInfo.colId = options.id;
  }

  if (colInfo.type === "DateTime") {
    const defaultTimezone = doc.docData?.docInfo().timezone ?? "UTC";
    colInfo.type += `:${options.timezone ?? defaultTimezone}`;
  }

  const originalType = column?.fields["type"] as string | undefined;
  const originalRefTableId =
    originalType && originalType.startsWith("Ref")
      ? getReferencedTableId(originalType)
      : null;
  const refTableId = options.reference_table_id ?? originalRefTableId;
  if (colInfo.type?.startsWith("Ref")) {
    if (!refTableId) {
      throw new Error("reference_table_id parameter is required");
    }

    colInfo.type += `:${refTableId}`;
  } else if (
    colInfo.type === undefined &&
    originalRefTableId &&
    options.reference_table_id
  ) {
    colInfo.type = `${originalRefTableId}:${options.reference_table_id}`;
  }
  if (
    "reference_show_column_id" in options &&
    options.reference_show_column_id !== undefined
  ) {
    if (!refTableId) {
      throw new Error(
        "reference_show_column_id parameter is only valid for Ref or RefList columns"
      );
    }

    colInfo.visibleCol = colIdsToRefs(
      doc,
      refTableId,
      options.reference_show_column_id
    )?.[0];
  }

  if (options.formula_type !== undefined) {
    colInfo.isFormula = options.formula_type === "regular";
  }
  if (colInfo.formula !== undefined && !colInfo.formula) {
    colInfo.isFormula = false;
  }
  if (
    "formula_recalc_col_ids" in options &&
    options.formula_recalc_col_ids !== undefined &&
    column
  ) {
    colInfo.recalcDeps = colIdsToRefs(
      doc,
      column.fields["parentId"] as number,
      ...(options.formula_recalc_col_ids ?? [])
    );
  }
  if ("formula_recalc_behavior" in options) {
    switch (options.formula_recalc_behavior) {
      case "add-record": {
        colInfo.recalcWhen = RecalcWhen.DEFAULT;
        colInfo.recalcDeps = null;
        break;
      }
      case "add-or-update-record": {
        colInfo.recalcWhen = RecalcWhen.MANUAL_UPDATES;
        colInfo.recalcDeps = null;
        break;
      }
      case "custom": {
        colInfo.recalcWhen = RecalcWhen.DEFAULT;
        break;
      }
      case "never": {
        colInfo.recalcWhen = RecalcWhen.NEVER;
        colInfo.recalcDeps = null;
        break;
      }
      default: {
        throw new Error(
          `Invalid formula_recalc_behavior: ${options.formula_recalc_behavior}`
        );
      }
    }
  }

  if (options.untie_col_id_from_label !== undefined) {
    colInfo.untieColIdFromLabel = options.untie_col_id_from_label;
  }

  const originalWidgetOptions = safeJsonParse(
    column?.fields["widgetOptions"] as any,
    {}
  );
  const widgetOptions: any = {};

  if (options.text_format !== undefined) {
    switch (options.text_format) {
      case "text": {
        widgetOptions.widget = "TextBox";
        break;
      }
      case "markdown": {
        widgetOptions.widget = "Markdown";
        break;
      }
      case "hyperlink": {
        widgetOptions.widget = "HyperLink";
        break;
      }
      default: {
        throw new Error(`Invalid text_format: ${options.text_format}`);
      }
    }
  }

  if (options.number_show_spinner !== undefined) {
    if (options.number_show_spinner) {
      widgetOptions.widget = "Spinner";
    } else {
      widgetOptions.widget = "TextBox";
    }
  }
  if (options.number_format !== undefined) {
    switch (options.number_format) {
      case "currency":
      case "decimal":
      case "percent":
      case "scientific": {
        widgetOptions.numMode = options.number_format;
        break;
      }
      case "text": {
        widgetOptions.numMode = null;
        break;
      }
      default: {
        throw new Error(`Invalid number_format: ${options.number_format}`);
      }
    }
  }
  if (options.number_currency_code !== undefined) {
    widgetOptions.currency = options.number_currency_code;
  }
  if (options.number_minus_sign !== undefined) {
    switch (options.number_minus_sign) {
      case "minus": {
        widgetOptions.numSign = null;
        break;
      }
      case "parens": {
        widgetOptions.numSign = "parens";
        break;
      }
      default: {
        throw new Error(
          `Invalid number_minus_sign: ${options.number_minus_sign}`
        );
      }
    }
  }
  if (options.number_min_decimals !== undefined) {
    widgetOptions.decimals = options.number_min_decimals;
  }
  if (options.number_max_decimals !== undefined) {
    widgetOptions.maxDecimals = options.number_max_decimals;
  }

  if (options.toggle_format !== undefined) {
    switch (options.toggle_format) {
      case "text": {
        widgetOptions.widget = "TextBox";
        break;
      }
      case "checkbox": {
        widgetOptions.widget = "CheckBox";
        break;
      }
      case "switch": {
        widgetOptions.widget = "Switch";
        break;
      }
      default: {
        throw new Error(`Invalid toggle_format: ${options.toggle_format}`);
      }
    }
  }

  if (options.date_format !== undefined) {
    if (options.date_format === "custom") {
      if (!options.date_custom_format) {
        throw new Error(
          "date_custom_format is required when date_format is custom"
        );
      }

      widgetOptions.dateFormat = options.date_custom_format;
      widgetOptions.isCustomDateFormat = true;
    } else {
      widgetOptions.dateFormat = options.date_format;
      widgetOptions.isCustomDateFormat = false;
    }
  }
  if (options.time_format !== undefined) {
    if (options.time_format === "custom") {
      if (!options.time_custom_format) {
        throw new Error(
          "time_custom_format is required when time_format is custom"
        );
      }

      widgetOptions.timeFormat = options.time_custom_format;
      widgetOptions.isCustomTimeFormat = true;
    } else {
      widgetOptions.timeFormat = options.time_format;
      widgetOptions.isCustomTimeFormat = false;
    }
  }

  if (options.attachment_height !== undefined) {
    widgetOptions.height = options.attachment_height;
  }

  if (options.text_alignment !== undefined) {
    widgetOptions.alignment = options.text_alignment;
  }
  if (options.text_wrap !== undefined) {
    widgetOptions.wrap = options.text_wrap;
  }

  if (options.choices !== undefined) {
    widgetOptions.choices = options.choices;
  }
  if (options.choice_styles !== undefined) {
    widgetOptions.choiceOptions = options.choice_styles;
  }

  if (options.cell_text_color !== undefined) {
    widgetOptions.textColor = options.cell_text_color;
  }
  if (options.cell_fill_color !== undefined) {
    widgetOptions.fillColor = options.cell_fill_color;
  }
  if (options.cell_bold !== undefined) {
    widgetOptions.fontBold = options.cell_bold;
  }
  if (options.cell_underline !== undefined) {
    widgetOptions.fontUnderline = options.cell_underline;
  }
  if (options.cell_italic !== undefined) {
    widgetOptions.fontItalic = options.cell_italic;
  }
  if (options.cell_strikethrough !== undefined) {
    widgetOptions.fontStrikethrough = options.cell_strikethrough;
  }
  if (options.header_text_color !== undefined) {
    widgetOptions.headerTextColor = options.header_text_color;
  }
  if (options.header_fill_color !== undefined) {
    widgetOptions.headerFillColor = options.header_fill_color;
  }
  if (options.header_bold !== undefined) {
    widgetOptions.headerFontBold = options.header_bold;
  }
  if (options.header_underline !== undefined) {
    widgetOptions.headerFontUnderline = options.header_underline;
  }
  if (options.header_italic !== undefined) {
    widgetOptions.headerFontItalic = options.header_italic;
  }
  if (options.header_strikethrough !== undefined) {
    widgetOptions.headerFontStrikethrough = options.header_strikethrough;
  }

  if (!isEmpty(widgetOptions)) {
    colInfo.widgetOptions = JSON.stringify({
      ...originalWidgetOptions,
      ...widgetOptions,
    });
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

function colIdsToRefs(
  doc: AssistanceDoc,
  tableIdOrRef: string | number,
  ...colIds: string[]
) {
  const docData = doc.docData;
  if (!docData) {
    throw new Error("Document not ready");
  }

  let tableRef: number;
  if (typeof tableIdOrRef === "string") {
    tableRef = docData
      .getMetaTable("_grist_Tables")
      .findRow("tableId", tableIdOrRef);
    if (tableRef === 0) {
      throw new Error(`Table ${tableIdOrRef} not found`);
    }
  } else {
    tableRef = tableIdOrRef;
  }

  const colIdsSet = new Set(colIds);
  const colRefs = docData
    .getMetaTable("_grist_Tables_column")
    .filterRecords({ parentId: tableRef })
    .filter((r) => colIdsSet.has(r.colId))
    .map((r) => r.id);
  return colRefs;
}
