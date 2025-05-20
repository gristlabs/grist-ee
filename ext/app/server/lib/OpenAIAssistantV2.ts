import { ApplyUAResult } from "app/common/ActiveDocAPI";
import {
  AssistanceMessage,
  AssistanceRequestV2,
  AssistanceResponseV2,
} from "app/common/Assistance";
import { AssistantProvider } from "app/common/Assistant";
import { delay } from "app/common/delay";
import { CellValue, getColValues } from "app/common/DocActions";
import { arrayRepeat } from "app/plugin/gutil";
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
import { ResultRow } from "app/server/lib/SqliteCommon";
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
  public static readonly DEFAULT_LONGER_CONTEXT_MODEL = "";

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
      message: { content, tool_calls },
      finish_reason,
    } = result.choices[0];
    return {
      choice: {
        message: {
          content,
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
    const content =
      "You are a helpful assistant for Grist. " +
      "If the user asks you a question about data in their document, translate it " +
      "to SQL (SQLite) and call the `runSQLQuery` function. " +
      "The `runSchemaCommand` function returns the output of running `.schema` on " +
      "the underlying database. " +
      "If the user asks you to add, update, or delete records in their document, " +
      "call one of the following functions: `addRecords`, `updateRecords`, `removeRecords`. " +
      'Column values may either be primitives (e.g. `true`, `123`, `"hello"`, `null` ' +
      "or tuples representing a Grist object. The first element of the tuple " +
      'is a string character representing the object code. For example, `["L", "foo", "bar"]` ' +
      'is a value of a Choice List column, where `"L"` is the type, and `"foo"` and ' +
      '`"bar"` are the choices.\n\n' +
      "### Grist Object Types\n\n" +
      "| Code | Type           |\n" +
      "| ---- | -------------- |\n" +
      '| `L`  | List, e.g. `["L", "foo", "bar"]` or `["L", 1, 2]` |\n' +
      '| `D`  | DateTimes, as `["D", timestamp, timezone]`, e.g. `["D", 1704945919, "UTC"]` |\n' +
      '| `d`  | Date, as `["d", timestamp]`, e.g. `["d", 1704844800]` |\n' +
      '| `R`  | Reference, as `["R", table_id, row_id]`, e.g. `["R", "People", 17]` |\n' +
      '| `r`  | ReferenceList, as `["r", table_id, row_id_list]`, e.g. `["r", "People", [1,2]]` |\n\n' +
      "Use appropriate values by calling `getColumns` to get each column's type. " +
      (visibleTableIds && visibleTableIds.length > 0
        ? `The user is looking at a page with tables: ${visibleTableIds.join(
            ", "
          )}. If the user doesn't mention a table, assume they are talking about one of these columns .`
        : "") +
      "For the `recordIds` parameter, you will need to call `runSQLQuery` first and " +
      "get the values out of the `id` column. " +
      "For the `records` parameter, you MUST provide an array of objects mapping column IDs " +
      "to values, excluding the `id` column. This parameter is required - do NOT ignore it. " +
      'Ignore any columns that start with "gristHelper_"; the user cannot see them. If a query ' +
      "fails because a table or column doesn't exist, call the `runSchemaCommand` " +
      "function again to make sure you have the most current version of the schema. " +
      "If the user asks for help modifying a formula, call `getFormulaToComplete` and " +
      "complete the Python function (a 'formula') at the end according to the user's request. " +
      "You should only include the function BODY in the `formula` parameter. " +
      "If any operation fails due to unsufficient access, tell the user they need full read " +
      "access to the document. " +
      "ALWAYS confirm with the user prior to making any modifications to their document.";
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
          required: [
            "response_text",
            "confirmation_required",
          ],
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
          name: "getFormulaColumn",
          description: "Returns metadata for a formula column.",
          parameters: {
            type: "object",
            properties: {
              tableId: {
                type: "string",
                description: "The ID of the table.",
              },
              columnId: {
                type: "string",
                description: "The ID of the column.",
              },
            },
            required: ["tableId", "columnId"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getColumns",
          description: "Returns metadata for all the columns in a table.",
          parameters: {
            type: "object",
            properties: {
              tableId: {
                type: "string",
                description: "The ID of the table.",
              },
            },
            required: ["tableId"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "getFormulaToComplete",
          description:
            "Returns an empty Python function (i.e. formula) to complete.",
          parameters: {
            type: "object",
            properties: {
              tableId: {
                type: "string",
                description: "The ID of the table.",
              },
              columnId: {
                type: "string",
                description: "The ID of the column.",
              },
            },
            required: ["tableId", "columnId"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "updateFormula",
          description: "Updates a column's formula.",
          parameters: {
            type: "object",
            properties: {
              tableId: {
                type: "string",
                description: "The ID of the table.",
              },
              columnId: {
                type: "string",
                description: "The ID of the column.",
              },
              formula: {
                type: "string",
                description: "The new formula.",
              },
            },
            required: ["tableId", "columnId", "formula"],
            additionalProperties: false,
          },
        },
      },
      {
        type: "function",
        function: {
          name: "runSchemaCommand",
          description:
            "Returns the output of running the `.schema` command " +
            "against a Grist/SQLite document.",
        },
      },
      {
        type: "function",
        function: {
          name: "runSQLQuery",
          description: "Runs a SQL query against a SQLite document.",
          parameters: {
            type: "object",
            properties: {
              sql: {
                type: "string",
                description:
                  "The SQL query to run. Must be a single SELECT statement, " +
                  "with no trailing semicolon. WITH clauses are permitted. ",
              },
              args: {
                type: ["array", "null"],
                description: "Arguments for parameters in the query.",
                items: {
                  type: ["string", "number"],
                },
              },
            },
            required: ["sql", "args"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      {
        type: "function",
        function: {
          name: "addRecords",
          description: "Adds one or more records to a table.",
          parameters: {
            type: "object",
            properties: {
              tableId: {
                type: "string",
                description: "The ID of the table.",
              },
              records: {
                type: "array",
                description: "The records to add.",
                items: {
                  description:
                    "A record. Maps column IDs to values, excluding the `id` column.",
                },
              },
            },
            required: ["tableId", "records"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "updateRecords",
          description: "Updates one or more records in a table.",
          parameters: {
            type: "object",
            properties: {
              tableId: {
                type: "string",
                description: "The ID of the table.",
              },
              recordIds: {
                type: "array",
                description: "The IDs of the records to update.",
                items: {
                  type: "number",
                },
              },
              records: {
                type: "array",
                description:
                  "The records to update, in the same order as `recordIds`.",
                items: {
                  description:
                    "A record. Maps column IDs to values, excluding the `id` column.",
                },
              },
            },
            required: ["tableId", "recordIds", "records"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "removeRecords",
          description: "Removes one or more records from a table.",
          parameters: {
            type: "object",
            properties: {
              tableId: {
                type: "string",
                description: "The ID of the table.",
              },
              recordIds: {
                type: "array",
                description: "The IDs of the records to remove.",
                items: {
                  type: "number",
                },
              },
            },
            required: ["tableId", "recordIds"],
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
    for (const call of message.tool_calls) {
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
      switch (name) {
        case "getFormulaColumn": {
          const tableId = stringParam(parameterArgs.tableId, "tableId");
          const columnId = stringParam(parameterArgs.columnId, "columnId");

          return {
            ok: true,
            result: await getFormulaColumn(docSession, doc, tableId, columnId),
          };
        }
        case "getColumns": {
          const tableId = stringParam(parameterArgs.tableId, "tableId");

          return {
            ok: true,
            result: await doc.getTableCols(docSession, tableId),
          };
        }
        case "getFormulaToComplete": {
          const tableId = stringParam(parameterArgs.tableId, "tableId");
          const columnId = stringParam(parameterArgs.columnId, "columnId");

          return {
            ok: true,
            result: await doc.assistanceSchemaPromptV1(docSession, {
              tableId,
              colId: columnId,
              includeAllTables: true,
              includeLookups: true,
            }),
          };
        }
        case "updateFormula": {
          const tableId = stringParam(parameterArgs.tableId, "tableId");
          const columnId = stringParam(parameterArgs.columnId, "columnId");
          const formula = stringParam(parameterArgs.formula, "formula");

          const column = await getFormulaColumn(
            docSession,
            doc,
            tableId,
            columnId
          );
          const actions = [
            [
              "UpdateRecord",
              "_grist_Tables_column",
              column.id,
              {
                formula,
              },
            ],
          ];
          const result = await doc.applyUserActions(docSession, actions);
          return {
            ok: true,
            result,
          };
        }
        case "runSchemaCommand": {
          const sql =
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND " +
            "name NOT LIKE '_grist%' AND name NOT LIKE 'GristHidden_%'";
          const queryResult = await runSQLQuery(docSession, doc, { sql });
          const result = queryResult.map((row: ResultRow) => row.sql).join("\n");
          return { ok: true, result };
        }
        case "runSQLQuery": {
          const sql = stringParam(parameterArgs.sql, "sql");
          const args = parameterArgs.args;
          const result = await runSQLQuery(docSession, doc, { sql, args });
          return { ok: true, result };
        }
        case "addRecords": {
          const tableId = stringParam(parameterArgs.tableId, "tableId");
          const records = parameterArgs.records;
          if (!records) {
            throw new Error("records parameter is required");
          }

          const actions = [
            [
              "BulkAddRecord",
              tableId,
              arrayRepeat(records.length, null),
              getColValues(records),
            ],
          ];
          const result = await doc.applyUserActions(docSession, actions, {
            parseStrings: true,
          });
          return { ok: true, result };
        }
        case "updateRecords": {
          const tableId = stringParam(parameterArgs.tableId, "tableId");
          const records = parameterArgs.records;
          const recordIds = parameterArgs.recordIds;
          if (!records) {
            throw new Error("records parameter is required");
          }
          if (!recordIds) {
            throw new Error("recordIds parameter is required");
          }

          const actions = [
            ["BulkUpdateRecord", tableId, recordIds, getColValues(records)],
          ];
          const result = await doc.applyUserActions(docSession, actions, {
            parseStrings: true,
          });
          return { ok: true, result };
        }
        case "removeRecords": {
          const tableId = stringParam(parameterArgs.tableId, "tableId");
          const recordIds = parameterArgs.recordIds;
          if (!recordIds) {
            throw new Error("recordIds parameter is required");
          }

          const actions = [["BulkRemoveRecord", tableId, recordIds]];
          const result = await doc.applyUserActions(docSession, actions, {
            parseStrings: true,
          });
          return { ok: true, result };
        }
        default: {
          throw new Error(`Unrecognized function: ${name}`);
        }
      }
    } catch (e) {
      return {
        ok: false,
        error: String(e),
      };
    }
  }

  private _buildResponse(
    completion: OpenAIChatCompletion,
    appliedActions?: ApplyUAResult[]
  ): AssistanceResponseV2 {
    const { content } = completion.choice.message;
    const { response_text, confirmation_required } = JSON.parse(content);
    return {
      reply: response_text,
      state: completion.state,
      appliedActions,
      confirmationRequired: confirmation_required,
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

async function getFormulaColumn(
  docSession: OptDocSession,
  doc: AssistanceDoc,
  tableId: string,
  columnId: string
) {
  const metaTables = await doc.fetchMetaTables(docSession);
  const allTables = metaTables["_grist_Tables"];
  let [, , ids, vals] = allTables;
  const tableRef = ids.find((_, idx) => vals["tableId"][idx] === tableId);
  if (!tableRef) {
    throw new Error(`Table ${tableId} not found`);
  }

  const allColumns = metaTables["_grist_Tables_column"];
  [, , ids, vals] = allColumns;
  const columns = ids.map((id, idx) => {
    return {
      id,
      colId: vals["colId"][idx],
      parentId: vals["parentId"][idx],
      isFormula: vals["isFormula"][idx],
      formula: vals["formula"][idx],
    };
  });
  const column = columns.find(
    (c) => c.colId === columnId && c.parentId === tableRef
  );
  if (!column) {
    throw new Error(`Column ${columnId} not found`);
  } else if (!column.isFormula && !column.formula) {
    throw new Error(`Column ${columnId} is not a formula column`);
  }

  return column;
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

  return viewSections
    .map((vs) => tablesByRef[vs.parentId as number]?.tableId)
    .filter((tableId) => tableId !== undefined);
}
