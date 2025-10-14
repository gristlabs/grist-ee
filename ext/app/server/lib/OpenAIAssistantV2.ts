import { ApplyUAOptions, ApplyUAResult } from "app/common/ActiveDocAPI";
import {
  AssistanceMessage,
  AssistanceRequestV2,
  AssistanceResponseV2,
} from "app/common/Assistance";
import { AssistantProvider } from "app/common/Assistant";
import {
  AccessLevel,
  ICustomWidget,
  matchWidget,
} from "app/common/CustomWidget";
import { delay } from "app/common/delay";
import { ColValues, getColValues, UserAction } from "app/common/DocActions";
import {
  extractTypeFromColType,
  getReferencedTableId,
  RecalcWhen,
} from "app/common/gristTypes";
import { safeJsonParse } from "app/common/gutil";
import { RecordWithStringId } from "app/plugin/DocApiTypes";
import { arrayRepeat } from "app/plugin/gutil";
import {
  handleSandboxErrorOnPlatform,
  TableOperationsPlatform,
} from "app/plugin/TableOperationsImpl";
import { ActiveDoc } from "app/server/lib/ActiveDoc";
import {
  getDocDataOrThrow,
  getTableById,
  getWidgetById,
  getWidgetsByPageId,
} from "app/server/lib/ActiveDocUtils";
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
import {
  getAndRemoveAssistantStatePermit,
  setAssistantStatePermit,
} from "app/server/lib/AssistantStatePermit";
import { isAnonymousUser, RequestWithLogin } from "app/server/lib/Authorizer";
import { getAndClearSignupStateCookie } from "app/server/lib/cookieUtils";
import { createSavedDoc } from "app/server/lib/createSavedDoc";
import { OptDocSession } from "app/server/lib/DocSession";
import { expressWrap } from "app/server/lib/expressWrap";
import { GristServer } from "app/server/lib/GristServer";
import {
  AssistanceDoc,
  AssistantV2,
  AssistantV2Options,
  FunctionCallResult,
  OpenAIChatCompletion,
  OpenAITool,
} from "app/server/lib/IAssistant";
import { LogMethods } from "app/server/lib/LogMethods";
import { OPENAI_TOOLS } from "app/server/lib/OpenAITools";
import {
  AddPageWidgetParams,
  AddPageWidgetParamsChecker,
  AddRecordsParams,
  AddRecordsParamsChecker,
  AddTableColumnOptions,
  AddTableColumnParams,
  AddTableColumnParamsChecker,
  AddTableParams,
  AddTableParamsChecker,
  GetPageWidgetSelectByOptionsParams,
  GetPageWidgetSelectByOptionsParamsChecker,
  GetPageWidgetsParams,
  GetPageWidgetsParamsChecker,
  GetTableColumnsParams,
  GetTableColumnsParamsChecker,
  QueryDocumentParams,
  QueryDocumentParamsChecker,
  RemovePageParams,
  RemovePageParamsChecker,
  RemovePageWidgetParams,
  RemovePageWidgetParamsChecker,
  RemoveRecordsParams,
  RemoveRecordsParamsChecker,
  RemoveTableColumnParams,
  RemoveTableColumnParamsChecker,
  RemoveTableParams,
  RemoveTableParamsChecker,
  RenameTableParams,
  RenameTableParamsChecker,
  SetPageWidgetSelectByParams,
  SetPageWidgetSelectByParamsChecker,
  UpdatePageParams,
  UpdatePageParamsChecker,
  UpdatePageWidgetParams,
  UpdatePageWidgetParamsChecker,
  UpdateRecordsParams,
  UpdateRecordsParamsChecker,
  UpdateTableColumnOptions,
  UpdateTableColumnParams,
  UpdateTableColumnParamsChecker,
} from "app/server/lib/OpenAIToolTypes";
import {
  getScope,
  optStringParam,
  stringParam,
} from "app/server/lib/requestUtils";
import { runSQLQuery } from "app/server/lib/runSQLQuery";
import { getSelectByOptions } from "app/server/lib/selectBy";
import { shortDesc } from "app/server/lib/shortDesc";
import * as express from "express";
import { isEmpty, omit, pick } from "lodash";
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

  private readonly _log = new LogMethods(
    "OpenAIAssistantV2 ",
    (info: { docSession: OptDocSession; doc: ActiveDoc } | null) =>
      info ? info.doc.getLogMeta(info.docSession) : {}
  );

  private _apiKey = this._options.apiKey;
  private _endpoint =
    this._options.completionEndpoint ??
    "https://api.openai.com/v1/chat/completions";
  private _model = this._options.model ?? null;
  private _longerContextModel = this._options.longerContextModel;
  private _maxTokens = this._options.maxTokens;
  private _maxToolCalls = this._options.maxToolCalls ?? 10;
  private _structuredOutput = this._options.structuredOutput ?? false;

  public constructor(
    private _gristServer: GristServer,
    private _options: AssistantV2Options
  ) {
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
        this._log.error(
          { docSession, doc },
          `exceeded max tool calls (${this._maxToolCalls})`
        );
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
          content: response.reply,
        },
        developerPromptVersion: request.developerPromptVersion,
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

  public addEndpoints(app: express.Application) {
    app.post(
      "/api/assistant/start",
      expressWrap(async (req, res) => {
        const mreq = req as RequestWithLogin;
        const prompt = stringParam(req.body.prompt, "prompt");
        const srcDocId = optStringParam(req.body.srcDocId, "srcDocId");
        this._gristServer
          .getTelemetry()
          .logEvent(mreq, "assistantStartDocument", {
            full: {
              userId: mreq.userId,
              altSessionId: mreq.altSessionId,
              prompt,
            },
          });
        let redirectUrl: string;
        if (isAnonymousUser(req)) {
          redirectUrl = await this._gristServer.getSigninUrl(req, {
            signUp: true,
            params: {
              assistantPrompt: prompt,
              srcDocId,
            },
          });
        } else {
          const docId = await createSavedDoc(this._gristServer, req, {
            srcDocId,
          });
          const store = this._gristServer.getPermitStore();
          const permit = {
            prompt,
            docId,
          };
          const assistantState = await setAssistantStatePermit(store, permit);
          const url = new URL(
            this._gristServer.getMergedOrgUrl(mreq, `/doc/${docId}`)
          );
          url.searchParams.set("assistantState", assistantState);
          redirectUrl = url.href;
        }
        res.json({ redirectUrl });
      })
    );
  }

  public async onFirstVisit(req: express.Request, res: express.Response) {
    await this._maybeRedirectToNewDocWithPrompt(req, res);
  }

  private async _maybeRedirectToNewDocWithPrompt(
    req: express.Request,
    res: express.Response
  ): Promise<void> {
    const state = getAndClearSignupStateCookie(req, res);
    if (!state) {
      return;
    }

    const { assistantState, srcDocId } = state;
    if (!assistantState) {
      return;
    }

    const store = this._gristServer.getPermitStore();
    const permit = await getAndRemoveAssistantStatePermit(store, assistantState);
    if (!permit) {
      return;
    }

    try {
      const docId = await createSavedDoc(this._gristServer, req, {
        srcDocId,
      });
      const newAssistantState = await setAssistantStatePermit(store, {
        ...permit,
        docId,
      });

      await this._gristServer.getHomeDBManager().updateOrg(getScope(req), 0, {
        userPrefs: {
          showNewUserQuestions: false,
        },
      });

      const url = new URL(
        this._gristServer.getMergedOrgUrl(
          req as RequestWithLogin,
          `/doc/${docId}`
        )
      );
      url.searchParams.set("assistantState", newAssistantState);
      return res.redirect(url.href);
    } catch (e) {
      this._log.warn(null, "failed to redirect to new doc with prompt", e);
    }
  }

  private async _getCompletion(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    request: AssistanceRequestV2
  ): Promise<OpenAIChatCompletion> {
    const messages = await this._buildMessages(doc, request);
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
    doc: AssistanceDoc,
    request: AssistanceRequestV2
  ) {
    const messages = request.state?.messages || [];
    messages[0] = await this._getDeveloperPrompt(doc, request);
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
          context: request.context,
          prompt: {
            index: start + index,
            role,
            content,
          },
          developerPromptVersion: request.developerPromptVersion,
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
      this._log.warn(null, "AI context length exceeded: ", errorMessage);
      if (messages.length <= 2) {
        throw new TokensExceededFirstMessageError();
      } else {
        throw new TokensExceededLaterMessageError();
      }
    }
    if (errorCode === "insufficient_quota") {
      this._log.error(null, "AI service provider billing quota exceeded!!!");
      throw new QuotaExceededError();
    }
    if (apiResponse.status !== 200) {
      const message = `AI service provider API returned status ${apiResponse.status}: ${resultText}`;
      this._log.error(null, message);
      throw new Error(message);
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

        this._log.warn(null, `waiting and then retrying after error`, e);
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
    doc: AssistanceDoc,
    request: AssistanceRequestV2
  ): Promise<AssistanceMessage> {
    const {
      context: { viewId },
      developerPromptVersion = "default",
    } = request;
    const view = viewId ? await getView(doc, viewId) : undefined;
    const content = `<identity>
You are an AI assistant for [Grist](https://www.getgrist.com), a collaborative spreadsheet-meets-database.
</identity>

<instructions>
${
  developerPromptVersion === "new-document"
    ? "The user will probably ask you to build a particular type of document. " +
      "Start by asking the user about their title/role, industry, and company. " +
      'Phrase it like: "Could you tell me more about yourself to help me build the ' +
      "perfect solution for you? Things like your title or role, industry and company " +
      'will help me tweak the solution to better fit your specific needs." ' +
      "Then, update the current document according to their answers and original prompt. " +
      "You MUST add at least 3 example records to each new table. " +
      "At the end, you MUST remove any irrelevant tables (e.g. Table1)."
    : ""
}
Help users modify or answer questions about their document.
${
  developerPromptVersion !== "new-document"
    ? "If the document looks new (i.e. only contains Table1), offer to set up the " +
      "document layout/structure according to a particular use case or template."
    : ""
}
After adding tables, ALWAYS ask the user if they'd like to add a few example records.
Follow idiomatic Grist conventions, like using Reference columns to link records from
related tables.
Always explain proposed changes in plain language.
DO NOT call modification APIs (e.g. add_records, update_records) until users confirm explicitly.
</instructions>

<tool_instructions>
Use get_tables and get_table_columns to discover valid IDs.
When the user refers to a column label, match it to the ID using get_table_columns.
If a table or column doesn't exist, check it hasn't been removed since you last queried the schema.
If a call fails due to insufficient access, tell the user they need full access to the document.
Use get_grist_access_rules_reference to learn how to answer questions about document access.
</tool_instructions>

<query_document_instructions>
Generate a single SQL SELECT query and call query_document.
Only SQLite-compatible SQL is supported.
</query_document_instructions>

<modification_instructions>
A document MUST have at least one table and page.
A table MUST have at least one column.
A page MUST have at least one widget.
Always use column IDs, not labels, when calling add_records or update_records.
Every table has an "id" column. NEVER set or modify it - only use it to
specify which records to update or remove.
Don't add ID columns when creating tables unless explicitly asked.
Only records, columns, pages, widgets, and tables can be modified.
When adding reference columns, try to set reference_show_column_id to a
sensible column instead of leaving it unset, which defaults to showing
the row ID.
All documents start with a default table (Table1). If it's empty and
a user asks you to create new tables, remove it.
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
${view ? `The user is currently on page ${view.name} (id: ${viewId}).` : ""}
</context>`;
    return {
      role: "system",
      content,
    };
  }

  private _getResponseFormat() {
    if (this._structuredOutput) {
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
    } else {
      return undefined;
    }
  }

  private _getTools(): OpenAITool[] {
    return OPENAI_TOOLS;
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
        safeJsonParse(args, {})
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
              content: JSON.stringify(omit(result, "appliedActions")),
            };
          }),
        ],
      },
    };
    const appliedActions = toolCallIdsAndResults
      .map(([_id, result]) => result.appliedActions)
      .filter((actions) => actions.filter((a) => a.isModification))
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
    params: unknown
  ): Promise<FunctionCallResult> {
    let result: any;
    let appliedActions: ApplyUAResult[] = [];
    this._log.debug(
      { docSession, doc },
      "_callFunction(%s, %s)",
      name,
      shortDesc(params)
    );
    try {
      switch (name) {
        case "get_tables": {
          result = this._getTables(doc);
          break;
        }
        case "add_table": {
          ({ result, appliedActions } = await this._addTable(
            docSession,
            doc,
            params
          ));
          break;
        }
        case "rename_table": {
          ({ result, appliedActions } = await this._renameTable(
            docSession,
            doc,
            params
          ));
          break;
        }
        case "remove_table": {
          ({ result, appliedActions } = await this._removeTable(
            docSession,
            doc,
            params
          ));
          break;
        }
        case "get_table_columns": {
          result = await this._getTableColumns(docSession, doc, params);
          break;
        }
        case "add_table_column": {
          ({ result, appliedActions } = await this._addTableColumn(
            docSession,
            doc,
            params
          ));
          break;
        }
        case "update_table_column": {
          ({ result, appliedActions } = await this._updateTableColumn(
            docSession,
            doc,
            params
          ));
          break;
        }
        case "remove_table_column": {
          ({ result, appliedActions } = await this._removeTableColumn(
            docSession,
            doc,
            params
          ));
          break;
        }
        case "get_pages": {
          result = this._getPages(doc);
          break;
        }
        case "update_page": {
          ({ result, appliedActions } = await this._updatePage(
            docSession,
            doc,
            params
          ));
          break;
        }
        case "remove_page": {
          ({ result, appliedActions } = await this._removePage(
            docSession,
            doc,
            params,
            {
              desc: "Called by OpenAIAssistantV2 (tool: remove_page)",
            }
          ));
          break;
        }
        case "get_page_widgets": {
          result = this._getPageWidgets(doc, params);
          break;
        }
        case "add_page_widget": {
          ({ result, appliedActions } = await this._addPageWidget(
            docSession,
            doc,
            params
          ));
          break;
        }
        case "update_page_widget": {
          ({ result, appliedActions } = await this._updatePageWidget(
            docSession,
            doc,
            params,
            {
              desc: "Called by OpenAIAssistantV2 (tool: update_page_widget)",
            }
          ));
          break;
        }
        case "remove_page_widget": {
          ({ result, appliedActions } = await this._removePageWidget(
            docSession,
            doc,
            params
          ));
          break;
        }
        case "get_page_widget_select_by_options": {
          result = await this._getPageWidgetSelectByOptions(doc, params);
          break;
        }
        case "set_page_widget_select_by": {
          ({ result, appliedActions } = await this._setPageWidgetSelectBy(
            docSession,
            doc,
            params
          ));
          break;
        }
        case "get_available_custom_widgets": {
          result = await this._getAvailableCustomWidgets();
          break;
        }
        case "query_document": {
          result = await this._queryDocument(docSession, doc, params);
          break;
        }
        case "add_records": {
          ({ result, appliedActions } = await this._addRecords(
            docSession,
            doc,
            params
          ));
          break;
        }
        case "update_records": {
          ({ result, appliedActions } = await this._updateRecords(
            docSession,
            doc,
            params
          ));
          break;
        }
        case "remove_records": {
          ({ result, appliedActions } = await this._removeRecords(
            docSession,
            doc,
            params
          ));
          break;
        }
        case "get_grist_access_rules_reference": {
          result = this._helpAccessRules();
          break;
        }
        default: {
          throw new Error(`Unrecognized function: ${name}`);
        }
      }
      this._log.debug(
        { docSession, doc },
        "_callFunction returning %s",
        shortDesc(result)
      );
      return { ok: true, result, appliedActions };
    } catch (e) {
      this._log.warn(
        { docSession, doc },
        "_callFunction error",
        e
      );
      return {
        ok: false,
        error: String(e),
        appliedActions,
      };
    }
  }

  private _helpAccessRules() {
    return `<access_rules_help>
<intro>
This is background material for the Grist Assistant. Use it to learn how
to query and read access rules. If the user has a question about access rules,
answer specifically, explaining the access rules in the document, and not just
talking in generalities.
</intro>

<overview>
Access rules are stored in special tables:
- _grist_ACLRules: list of rules. Order matters (rulePos).
- _grist_ACLResources: defines the scope (table and columns) for each rule.
Join _grist_ACLRules.resource to _grist_ACLResources for context.
Ignore resources not referenced by a rule.
Group rules by resource when describing them.
</overview>

<schema>
_grist_ACLRules:
  resource (Ref:_grist_ACLResources)
  aclFormula (Text, Python subset)
  permissionsText (Text: '+CRUDS', '-RU', ..., 'all', 'none')
  rulePos (PositionNumber)
  memo (Text)

_grist_ACLResources:
  tableId (Text)
  colIds (Text: '*' or comma-separated column IDs)
</schema>

<permissions>
Actions and their codes:
  C - Create rows
  R - Read cells
  U - Update cells
  D - Delete rows
  S - Change table structure
A leading + allows, - denies. Example: '+CRUD', '-RU'.
Rules are evaluated in order; the first match for each permission wins.
</permissions>

<formulas>
aclFormula is a condition using a Python-like syntax.

Variables:
  user.Access (owners | editors | viewers)
  user.Email, user.UserID, user.Name, user.LinkKey, user.SessionID
  rec (current record)
  newRec (proposed record after edit)
Custom user attributes (from userAttributes) may add variables like user.Person.

Supported operators: and, or, +, -, *, /, %, ==, !=, <, <=, >, >=, is, is not, in, not in.
</formulas>

<guidance>
When answering access-rule questions:
1. Mention any custom user attributes first.
2. List rules grouped by resource (table/columns).
3. For each rule, explain who (formula) and what (permissions).
4. Highlight row-level conditions (rec, newRec) if present.
5. First match for each permission wins.
6. When creating rules, always add a memo starting with [PROPOSED].
</guidance>

<examples>
Example 1: Owners only for Houses:
- Resource: Houses, all columns (*)
- Rule: user.Access != OWNER
- Permissions: none (-CRUDS)

Example 2: Editors can update Jobs only when Ready:
- user.Access == OWNER, +CRUDS
- user.Access == EDITOR and rec.Ready != True, -U
- user.Access == EDITOR, all
- everyone else, none

Notes:
- Resources are part of rules, never listed alone.
- The memo helps explain rules to denied users.
</examples>
</access_rules_help>`;
  }

  private _getTables(doc: AssistanceDoc) {
    const docData = getDocDataOrThrow(doc);
    const getTitle = docData
      .getMetaTable("_grist_Views_section")
      .getRowPropFunc("title");
    const tables = docData
      .getMetaTable("_grist_Tables")
      .getRecords()
      .filter(({ tableId }) => tableId && !tableId.startsWith("GristHidden_"));
    return tables.map((table) => {
      return {
        id: table.tableId,
        name: getTitle(table.rawViewSectionRef),
      };
    });
  }

  private async _addTable(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ) {
    AddTableParamsChecker.strictCheck(params);
    const { table_id, columns } = params as AddTableParams;
    let actions: UserAction[];
    if (!columns) {
      // AddEmptyTable includes default columns ('A', 'B', 'C'), unlike
      // AddTable, which creates a table with no columns that appears broken
      // in the UI.
      actions = [["AddEmptyTable", table_id]];
    } else {
      actions = [["AddTable", table_id, columns]];
    }
    const appliedActions = [
      await handleSandboxError(
        table_id,
        [],
        doc.applyUserActions(docSession, actions, {
          desc: "Called by OpenAIAssistantV2 (tool: add_table)",
        })
      ),
    ];
    return {
      result: {
        id: appliedActions[0].retValues[0].table_id,
      },
      appliedActions,
    };
  }

  private async _renameTable(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ) {
    RenameTableParamsChecker.strictCheck(params);
    const { table_id, new_table_id } = params as RenameTableParams;
    const appliedActions = [
      await handleSandboxError(
        table_id,
        [],
        doc.applyUserActions(
          docSession,
          [["RenameTable", table_id, new_table_id]],
          {
            desc: "Called by OpenAIAssistantV2 (tool: rename_table)",
          }
        )
      ),
    ];
    return {
      result: {
        id: appliedActions[0].retValues[0],
      },
      appliedActions,
    };
  }

  private async _removeTable(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ) {
    RemoveTableParamsChecker.strictCheck(params);
    const { table_id } = params as RemoveTableParams;
    const appliedActions = [
      await handleSandboxError(
        table_id,
        [],
        doc.applyUserActions(docSession, [["RemoveTable", table_id]], {
          desc: "Called by OpenAIAssistantV2 (tool: remove_table)",
        })
      ),
    ];
    return {
      result: null,
      appliedActions,
    };
  }

  private async _getTableColumns(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ) {
    GetTableColumnsParamsChecker.strictCheck(params);
    const { table_id } = params as GetTableColumnsParams;
    return await doc.getTableCols(docSession, table_id);
  }

  private async _addTableColumn(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ) {
    AddTableColumnParamsChecker.strictCheck(params);
    const { table_id, column_id, column_options } =
      params as AddTableColumnParams;
    const colInfo = column_options
      ? buildColInfo(doc, null, column_options)
      : {};
    const appliedActions = [
      await handleSandboxError(
        table_id,
        [column_id],
        doc.applyUserActions(
          docSession,
          [["AddVisibleColumn", table_id, column_id, colInfo]],
          {
            desc: "Called by OpenAIAssistantV2 (tool: add_table_column)",
          }
        )
      ),
    ];
    return {
      result: appliedActions[0].retValues[0].colId,
      appliedActions,
    };
  }

  private async _updateTableColumn(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ) {
    await this._checkUpdateTableColumnParams(docSession, doc, params);
    const { table_id, column_id, column_options } =
      params as UpdateTableColumnParams;
    const column = await this._getTableColumn(
      docSession,
      doc,
      table_id,
      column_id
    );
    const colInfo = buildColInfo(doc, column, column_options);
    const actions: UserAction[] = [
      ["ModifyColumn", table_id, column_id, colInfo],
    ];
    if (
      "reference_show_column_id" in column_options &&
      column_options.reference_show_column_id !== undefined
    ) {
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
        table_id,
        null,
        column.fields["colRef"],
        `$${column.id}.${column_options.reference_show_column_id}`,
      ]);
    }
    const appliedActions = [
      await handleSandboxError(
        table_id,
        [column_id],
        doc.applyUserActions(docSession, actions, {
          desc: "Called by OpenAIAssistantV2 (tool: update_table_column)",
        })
      ),
    ];
    return {
      result: null,
      appliedActions,
    };
  }

  private async _checkUpdateTableColumnParams(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ): Promise<void> {
    if (
      typeof params !== "object" ||
      params === null ||
      typeof params.table_id !== "string" ||
      typeof params.column_id !== "string" ||
      typeof params.column_options !== "object" ||
      params.column_options === null ||
      params.column_options.type !== undefined
    ) {
      UpdateTableColumnParamsChecker.strictCheck(params);
      return;
    }

    const column = await this._getTableColumn(
      docSession,
      doc,
      params.table_id,
      params.column_id
    );
    const { type } = column.fields;
    const paramsWithType = {
      ...params,
      column_options: {
        ...params.column_options,
        type: extractTypeFromColType(type as string),
      },
    };
    UpdateTableColumnParamsChecker.strictCheck(paramsWithType);
  }

  private async _getTableColumn(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    tableId: string,
    columnId: string
  ) {
    const columns = await doc.getTableCols(docSession, tableId);
    const column = columns.find((c) => c.id === columnId);
    if (!column) {
      throw new Error(`Column ${columnId} not found`);
    }

    return column;
  }

  private async _removeTableColumn(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ) {
    RemoveTableColumnParamsChecker.strictCheck(params);
    const { table_id, column_id } = params as RemoveTableColumnParams;
    const appliedActions = [
      await handleSandboxError(
        table_id,
        [column_id],
        doc.applyUserActions(
          docSession,
          [["RemoveColumn", table_id, column_id]],
          {
            desc: "Called by OpenAIAssistantV2 (tool: remove_table_column)",
          }
        )
      ),
    ];
    return {
      result: null,
      appliedActions,
    };
  }

  private _getPages(doc: AssistanceDoc) {
    return getDocDataOrThrow(doc)
      .getMetaTable("_grist_Views")
      .getRecords()
      .map((view) => pick(view, "id", "name"));
  }

  private async _updatePage(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ) {
    UpdatePageParamsChecker.strictCheck(params);
    const { page_id, page_options } = params as UpdatePageParams;
    const appliedActions = [
      await doc.applyUserActions(
        docSession,
        [["UpdateRecord", "_grist_Views", page_id, pick(page_options, "name")]],
        {
          desc: "Called by OpenAIAssistantV2 (tool: update_page)",
        }
      ),
    ];
    return {
      result: null,
      appliedActions,
    };
  }

  private async _removePage(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any,
    applyUAOptions: ApplyUAOptions
  ) {
    RemovePageParamsChecker.strictCheck(params);
    const { page_id } = params as RemovePageParams;
    const appliedActions = [
      await doc.applyUserActions(
        docSession,
        [["RemoveRecord", "_grist_Views", page_id]],
        applyUAOptions
      ),
    ];
    return {
      result: null,
      appliedActions,
    };
  }

  private _getPageWidgets(doc: AssistanceDoc, params: any) {
    GetPageWidgetsParamsChecker.strictCheck(params);
    const { page_id } = params as GetPageWidgetsParams;
    const getTableId = getDocDataOrThrow(doc)
      .getMetaTable("_grist_Tables")
      .getRowPropFunc("tableId");
    return getWidgetsByPageId(doc, page_id).map(
      ({ id, tableRef, title, description, parentKey }) => ({
        id,
        table_id: getTableId(tableRef),
        title,
        description,
        type: parentKeyToWidgetType[parentKey] ?? parentKey,
      })
    );
  }

  private async _addPageWidget(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ) {
    AddPageWidgetParamsChecker.strictCheck(params);
    const { page_id, widget_options } = params as AddPageWidgetParams;
    const { table_id, group_by_column_ids, ...updateOptions } = widget_options;
    let tableRef = table_id ? tableIdToRef(doc, table_id) : 0;
    const type =
      widgetTypeToParentKey[widget_options.type] ?? widget_options.type;
    let groupByColRefs: number[] | null = null;
    if (group_by_column_ids) {
      if (tableRef === 0) {
        throw new Error(
          "table_id cannot be null if group_by_column_ids is set"
        );
      }

      groupByColRefs = colIdsToRefs(doc, tableRef, ...group_by_column_ids);
    }
    const appliedActions: ApplyUAResult[] = [];
    const createViewSectionResult = await doc.applyUserActions(
      docSession,
      [
        [
          "CreateViewSection",
          tableRef,
          page_id ?? 0,
          type,
          groupByColRefs,
          table_id,
        ],
      ],
      {
        desc: "Called by OpenAIAssistantV2 (tool: add_page_widget)",
      }
    );
    appliedActions.push(createViewSectionResult);
    const retValues = createViewSectionResult.retValues[0];
    ({ tableRef } = retValues);
    const { viewRef, sectionRef } = retValues;
    if (Object.keys(updateOptions).length > 0) {
      const { appliedActions: actions } = await this._updatePageWidget(
        docSession,
        doc,
        { widget_id: sectionRef, widget_options: updateOptions },
        {
          desc: "Called by OpenAIAssistantV2 (tool: add_page_widget)",
        }
      );
      appliedActions.push(...actions);
    }
    const result = {
      table_id: tableRefToId(doc, tableRef),
      page_id: viewRef,
      widget_id: sectionRef,
    };
    return {
      result,
      appliedActions,
    };
  }

  private async _updatePageWidget(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any,
    applyUAOptions?: ApplyUAOptions
  ) {
    this._checkUpdatePageWidgetParams(doc, params);
    const { widget_id, widget_options } = params;
    const { parentKey, options: pageWidgetOptions } = getWidgetById(
      doc,
      widget_id
    );

    const parsedPageWidgetOptions = safeJsonParse(pageWidgetOptions, {});
    const colValues: ColValues = pick(widget_options, "title", "description");

    const originalType = parentKeyToWidgetType[parentKey] ?? parentKey;
    const { type = originalType } = widget_options;
    if (type !== originalType) {
      colValues.parentKey = widgetTypeToParentKey[type] ?? type;
    }

    if (
      type === "custom" &&
      ("custom_widget_id" in widget_options ||
        "custom_widget_url" in widget_options)
    ) {
      let customWidgetId: string | undefined;
      let customWidgetUrl: string | undefined;
      let customWidget: ICustomWidget | undefined;
      if ("custom_widget_id" in widget_options) {
        customWidgetId = widget_options.custom_widget_id;
      } else {
        customWidgetUrl = widget_options.custom_widget_url;
      }

      if (customWidgetId) {
        const widgets = await this._gristServer
          .getWidgetRepository()
          .getWidgets();
        customWidget = matchWidget(widgets, { widgetId: customWidgetId });
        if (!customWidget) {
          throw new Error(`Widget ${customWidgetId} not found`);
        }
      }
      parsedPageWidgetOptions.customView = JSON.stringify({
        mode: "url",
        url: customWidget ? null : customWidgetUrl,
        widgetId: customWidget?.widgetId ?? null,
        pluginId: customWidget?.source?.pluginId ?? "",
        widgetDef: customWidget ?? null,
        access: AccessLevel.none,
        columnsMapping: null,
        widgetOptions: null,
        renderAfterReady: customWidget?.renderAfterReady ?? false,
      });
    }

    colValues.options = JSON.stringify(parsedPageWidgetOptions);

    const appliedActions = [
      await doc.applyUserActions(
        docSession,
        [["UpdateRecord", "_grist_Views_section", widget_id, colValues]],
        applyUAOptions
      ),
    ];
    return {
      result: null,
      appliedActions,
    };
  }

  private _checkUpdatePageWidgetParams(
    doc: AssistanceDoc,
    params: any
  ): asserts params is UpdatePageWidgetParams {
    if (
      typeof params !== "object" ||
      params === null ||
      typeof params.widget_id !== "number" ||
      typeof params.widget_options !== "object" ||
      params.widget_options === null ||
      params.widget_options.type !== undefined
    ) {
      UpdatePageWidgetParamsChecker.strictCheck(params);
      return;
    }

    const { parentKey } = getWidgetById(doc, params.widget_id);
    const paramsWithType = {
      ...params,
      widget_options: {
        ...params.widget_options,
        type: parentKeyToWidgetType[parentKey] ?? parentKey,
      },
    };
    UpdatePageWidgetParamsChecker.strictCheck(paramsWithType);
  }

  private async _removePageWidget(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ) {
    RemovePageWidgetParamsChecker.strictCheck(params);
    const { widget_id } = params as RemovePageWidgetParams;
    const docData = getDocDataOrThrow(doc);
    const pageId = docData
      .getMetaTable("_grist_Views_section")
      .getValue(widget_id, "parentId");
    if (!pageId) {
      throw new Error(`Widget ${widget_id} does not belong to a page`);
    }

    const pageWidgets = docData
      .getMetaTable("_grist_Views_section")
      .filterRecords({ parentId: pageId });
    let appliedActions: ApplyUAResult[];
    if (pageWidgets.length === 1) {
      ({ appliedActions } = await this._removePage(
        docSession,
        doc,
        { page_id: pageId },
        {
          desc: "Called by OpenAIAssistantV2 (tool: remove_page_widget)",
        }
      ));
    } else {
      appliedActions = [
        await doc.applyUserActions(
          docSession,
          [["RemoveRecord", "_grist_Views_section", widget_id]],
          {
            desc: "Called by OpenAIAssistantV2 (tool: remove_page_widget)",
          }
        ),
      ];
    }
    return {
      result: null,
      appliedActions,
    };
  }

  private async _getPageWidgetSelectByOptions(doc: AssistanceDoc, params: any) {
    GetPageWidgetSelectByOptionsParamsChecker.strictCheck(params);
    const { widget_id } = params as GetPageWidgetSelectByOptionsParams;
    return getSelectByOptions(doc, widget_id);
  }

  private async _setPageWidgetSelectBy(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ) {
    SetPageWidgetSelectByParamsChecker.strictCheck(params);
    const { widget_id, widget_select_by } =
      params as SetPageWidgetSelectByParams;
    const widget = getWidgetById(doc, widget_id);
    const linkSrcSectionRef = widget_select_by?.link_from_widget_id ?? 0;
    let linkSrcColRef = 0;
    let linkTargetColRef = 0;
    if (linkSrcSectionRef) {
      if (widget_select_by?.link_from_column_id) {
        const sourceWidget = getWidgetById(doc, linkSrcSectionRef);
        const table = getTableById(doc, sourceWidget.tableRef);
        linkSrcColRef = colIdsToRefs(
          doc,
          table.id,
          widget_select_by.link_from_column_id
        )?.[0];
      }

      if (widget_select_by?.link_to_column_id) {
        const table = getTableById(doc, widget.tableRef);
        linkTargetColRef = colIdsToRefs(
          doc,
          table.id,
          widget_select_by.link_to_column_id
        )?.[0];
      }
    }
    const appliedActions = [
      await doc.applyUserActions(
        docSession,
        [
          [
            "UpdateRecord",
            "_grist_Views_section",
            widget_id,
            {
              linkSrcSectionRef,
              linkSrcColRef,
              linkTargetColRef,
            },
          ],
        ],
        {
          desc: "Called by OpenAIAssistantV2 (tool: set_page_widget_select_by)",
        }
      ),
    ];
    return {
      result: null,
      appliedActions,
    };
  }

  private async _getAvailableCustomWidgets() {
    return this._gristServer.getWidgetRepository().getWidgets();
  }

  private async _queryDocument(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ) {
    QueryDocumentParamsChecker.strictCheck(params);
    const { query: sql, args } = params as QueryDocumentParams;
    return await runSQLQuery(docSession, doc, {
      sql,
      args,
    });
  }

  private async _addRecords(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ) {
    AddRecordsParamsChecker.strictCheck(params);
    const { table_id, records } = params as AddRecordsParams;
    const appliedActions = [
      await handleSandboxError(
        table_id,
        [],
        doc.applyUserActions(
          docSession,
          [
            [
              "BulkAddRecord",
              table_id,
              arrayRepeat(records.length, null),
              getColValues(records),
            ],
          ],
          {
            desc: "Called by OpenAIAssistantV2 (tool: add_records)",
            parseStrings: true,
          }
        )
      ),
    ];
    const result = {
      ids: appliedActions[0].retValues[0],
    };
    return {
      result,
      appliedActions,
    };
  }

  private async _updateRecords(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ) {
    UpdateRecordsParamsChecker.strictCheck(params);
    const { table_id, record_ids, records } = params as UpdateRecordsParams;
    const appliedActions = [
      await handleSandboxError(
        table_id,
        [],
        doc.applyUserActions(
          docSession,
          [["BulkUpdateRecord", table_id, record_ids, getColValues(records)]],
          {
            desc: "Called by OpenAIAssistantV2 (tool: update_records)",
            parseStrings: true,
          }
        )
      ),
    ];
    return {
      result: null,
      appliedActions,
    };
  }

  private async _removeRecords(
    docSession: OptDocSession,
    doc: AssistanceDoc,
    params: any
  ) {
    RemoveRecordsParamsChecker.strictCheck(params);
    const { table_id, record_ids } = params as RemoveRecordsParams;
    const appliedActions = [
      await handleSandboxError(
        table_id,
        [],
        doc.applyUserActions(
          docSession,
          [["BulkRemoveRecord", table_id, record_ids]],
          {
            desc: "Called by OpenAIAssistantV2 (tool: remove_records)",
          }
        )
      ),
    ];
    return {
      result: null,
      appliedActions,
    };
  }

  private _buildResponse(
    completion: OpenAIChatCompletion,
    appliedActions?: ApplyUAResult[]
  ): AssistanceResponseV2 {
    const { choice: { message }, state } = completion;
    const { refusal } = message;
    if (refusal) {
      return {
        reply: refusal,
        state,
        appliedActions,
      };
    }

    let rawContent = message.content;
    if (typeof rawContent !== "string" || rawContent.trim() === "") {
      throw new Error("Expected non-empty content in response");
    }

    let reply: string;
    let confirmationRequired: boolean | undefined;

    if (this._structuredOutput) {
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

      const { response_text, confirmation_required } = parsedContent;
      if (typeof response_text !== "string" || response_text.trim() === "") {
        throw new Error("Expected non-empty response_text in content");
      }

      reply = response_text;
      confirmationRequired = confirmation_required;
    } else {
      reply = rawContent;
    }

    return {
      reply,
      state,
      appliedActions,
      confirmationRequired,
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
      await new Promise((r) => setTimeout(r, 1000));
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

const parentKeyToWidgetType: Record<string, string> = {
  record: "table",
  single: "card",
  detail: "card_list",
};

const widgetTypeToParentKey: Record<string, string> = {
  table: "record",
  card: "single",
  card_list: "detail",
};

async function getView(doc: AssistanceDoc, viewId: number) {
  return getDocDataOrThrow(doc).getMetaTable("_grist_Views").getRecord(viewId);
}

function buildColInfo(
  doc: AssistanceDoc,
  column: RecordWithStringId | null,
  options: AddTableColumnOptions | UpdateTableColumnOptions
): Partial<ColInfo> {
  const colInfo: Partial<ColInfo> = pick(
    options,
    "type",
    "label",
    "formula",
    "description"
  );

  if ("id" in options && options.id) {
    colInfo.colId = options.id;
  }

  if (colInfo.type === "DateTime") {
    if ("timezone" in options && options.timezone !== undefined) {
      colInfo.type += `:${options.timezone}`;
    } else {
      const defaultTimezone = getDocDataOrThrow(doc).docInfo().timezone ?? "UTC";
      colInfo.type += `:${defaultTimezone}`;
    }
  }

  const originalType = column?.fields["type"] as string | undefined;
  const originalRefTableId =
    originalType && originalType.startsWith("Ref")
      ? getReferencedTableId(originalType)
      : null;
  const refTableId =
    "reference_table_id" in options && options.reference_table_id
      ? options.reference_table_id
      : originalRefTableId;
  if (colInfo.type?.startsWith("Ref")) {
    if (!refTableId) {
      throw new Error("reference_table_id parameter is required");
    }

    colInfo.type += `:${refTableId}`;
  } else if (
    colInfo.type === undefined &&
    originalRefTableId &&
    "reference_table_id" in options &&
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

  if ("text_format" in options && options.text_format !== undefined) {
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

  if (
    "number_show_spinner" in options &&
    options.number_show_spinner !== undefined
  ) {
    if (options.number_show_spinner) {
      widgetOptions.widget = "Spinner";
    } else {
      widgetOptions.widget = "TextBox";
    }
  }
  if ("number_format" in options && options.number_format !== undefined) {
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
  if (
    "number_currency_code" in options &&
    options.number_currency_code !== undefined
  ) {
    widgetOptions.currency = options.number_currency_code;
  }
  if (
    "number_minus_sign" in options &&
    options.number_minus_sign !== undefined
  ) {
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
  if (
    "number_min_decimals" in options &&
    options.number_min_decimals !== undefined
  ) {
    widgetOptions.decimals = options.number_min_decimals;
  }
  if (
    "number_max_decimals" in options &&
    options.number_max_decimals !== undefined
  ) {
    widgetOptions.maxDecimals = options.number_max_decimals;
  }

  if ("toggle_format" in options && options.toggle_format !== undefined) {
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

  if ("date_format" in options && options.date_format !== undefined) {
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
  if ("time_format" in options && options.time_format !== undefined) {
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

  if (
    "attachment_height" in options &&
    options.attachment_height !== undefined
  ) {
    widgetOptions.height = options.attachment_height;
  }

  if ("text_alignment" in options && options.text_alignment !== undefined) {
    widgetOptions.alignment = options.text_alignment;
  }
  if ("text_wrap" in options && options.text_wrap !== undefined) {
    widgetOptions.wrap = options.text_wrap;
  }

  if ("choices" in options && options.choices !== undefined) {
    widgetOptions.choices = options.choices;
  }
  if ("choice_styles" in options && options.choice_styles !== undefined) {
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

function tableIdToRef(doc: AssistanceDoc, tableId: string) {
  const tableRef = getDocDataOrThrow(doc)
    .getMetaTable("_grist_Tables")
    .findRow("tableId", tableId);
  if (tableRef === 0) {
    throw new Error(`Table ${tableId} not found`);
  }

  return tableRef;
}

function tableRefToId(doc: AssistanceDoc, tableRef: number) {
  const tableId = getDocDataOrThrow(doc)
    .getMetaTable("_grist_Tables")
    .getValue(tableRef, "tableId");
  if (tableId === undefined) {
    throw new Error(`Table ${tableRef} not found`);
  }

  return tableId;
}

function colIdsToRefs(
  doc: AssistanceDoc,
  tableIdOrRef: string | number,
  ...colIds: string[]
) {
  const docData = getDocDataOrThrow(doc);
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
