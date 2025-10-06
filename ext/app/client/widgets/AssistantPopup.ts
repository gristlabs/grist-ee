import * as commands from 'app/client/components/commands';
import { GristDoc } from "app/client/components/GristDoc";
import { ChatHistory } from "app/client/models/ChatHistory";
import { makeT } from "app/client/lib/localization";
import {
  localStorageJsonObs,
  sessionStorageJsonObs,
} from "app/client/lib/localStorageObs";
import { inlineMarkdown } from "app/client/lib/markdown";
import { logTelemetryEvent } from "app/client/lib/telemetry";
import { FloatingPopup, PopupPosition } from "app/client/ui/FloatingPopup";
import { IAssistantPopup } from "app/client/ui/IAssistantPopup";
import {
  cssLinkText,
  cssPageEntry,
  cssPageIcon,
  cssPageLink,
} from "app/client/ui/LeftPanelCommon";
import { theme, vars } from "app/client/ui2018/cssVars";
import { icon } from "app/client/ui2018/icons";
import { cssLink } from "app/client/ui2018/links";
import { menu, menuItem } from "app/client/ui2018/menus";
import { Assistant, cssAiImage, cssAvatar } from "app/client/widgets/Assistant";
import {
  cssAiIntroMessage,
  cssAiMessageParagraph,
} from "app/client/widgets/FormulaAssistant";
import { AssistantState } from "app/common/ActiveDocAPI";
import { AssistanceState, DeveloperPromptVersion } from "app/common/Assistance";
import { commonUrls } from "app/common/gristUrls";
import { TelemetryEvent, TelemetryMetadata } from "app/common/Telemetry";
import { getGristConfig } from "app/common/urlUtils";
import { Disposable, dom, DomContents, DomElementArg, makeTestId, styled } from "grainjs";
import { v4 as uuidv4 } from "uuid";

const t = makeT("Assistant");

const testId = makeTestId("test-assistant-");

export function buildAssistantPopup(gristDoc: GristDoc): IAssistantPopup | null {
  const { assistant } = getGristConfig();
  if (!assistant || assistant.version === 1) {
    return null;
  }

  return AssistantPopup.create(gristDoc, gristDoc);
}

class AssistantPopup extends Disposable {
  private _appModel = this._gristDoc.appModel;
  private _userId = this._appModel.currentUser?.id ?? 0;
  private _docId = this._gristDoc.docId();
  private _history = this.autoDispose(
    localStorageJsonObs<ChatHistory>(
      `u:${this._userId};d:${this._docId};assistantHistory`,
      {
        messages: [],
        conversationId: uuidv4(),
        developerPromptVersion: "default",
      }
    )
  );
  private _width = this.autoDispose(
    sessionStorageJsonObs(
      `u:${this._userId};d:${this._docId};assistantWidth`,
      436
    )
  );
  private _height = this.autoDispose(
    sessionStorageJsonObs(
      `u:${this._userId};d:${this._docId};assistantHeight`,
      711
    )
  );
  private _position = this.autoDispose(
    sessionStorageJsonObs<PopupPosition | undefined>(
      `u:${this._userId};d:${this._docId};assistantPosition`,
      undefined
    )
  );
  private _assistant: Assistant = Assistant.create(this, {
    history: this._history,
    gristDoc: this._gristDoc,
    onSend: this._sendMessage.bind(this),
    buildIntroMessage,
  });
  private _popup = FloatingPopup.create(this, {
    title: this._buildPopupTitle.bind(this),
    content: this._buildPopupContent.bind(this),
    onMoveEnd: (position) => this._position.set(position),
    onResizeEnd: ({ width, height, ...position }) => {
      this._width.set(width);
      this._height.set(height);
      this._position.set(position);
    },
    width: this._width.get(),
    height: this._height.get(),
    minWidth: 328,
    minHeight: 300,
    position: this._position.get(),
    minimizable: true,
    closeButton: true,
    closeButtonHover: () => t("Close"),
    closeBehavior: "hide",
    testId,
  });
  private _openedOnce = false;

  constructor(private _gristDoc: GristDoc) {
    super();
  }

  public open() {
    this._popup.showPopup();
    if (!this._openedOnce) {
      this._assistant.scrollToBottom({ smooth: false, sync: true });
      this._openedOnce = true;
    }
    this._assistant.focus();
    this._logTelemetryEvent("assistantOpen");
  }

  public setState({ prompt }: AssistantState) {
    this._history.set({ ...this._history.get(), developerPromptVersion: "new-document" });
    this._assistant.send(prompt).catch(reportError);
  }

  private _buildPopupTitle(): DomContents {
    return cssPopupTitle(icon("Robot"), t("Assistant"));
  }

  private _buildPopupContent(): DomContents {
    return cssPopupContent(
      this._buildToolbar(),
      this._buildAssistant(),
    );
  }

  private _buildToolbar() {
    return cssToolbar(
      cssToolbarButtons(
        cssToolbarButton(
          icon("Dots"),
          menu(
            () => [
              menuItem(
                () => this._assistant.clear(),
                t("Clear Conversation"),
                testId("options-clear-conversation")
              ),
            ],
            { menuWrapCssClass: cssChatOptionsMenu.className }
          ),
          testId("options")
        )
      )
    );
  }

  private _buildAssistant() {
    return cssAssistant(this._assistant.buildDom());
  }

  private async _sendMessage(message: string) {
    const { developerPromptVersion = "default", state } = this._history.get();
    return await askAI(this._gristDoc, {
      description: message,
      conversationId: this._assistant.conversationId,
      developerPromptVersion,
      state,
    });
  }

  private _logTelemetryEvent(
    event: TelemetryEvent,
    metadata: TelemetryMetadata = {}
  ) {
    logTelemetryEvent(event, {
      full: {
        version: 2,
        docIdDigest: this._gristDoc.docId(),
        conversationId: this._assistant.conversationId,
        context: {
          viewId: this._gristDoc.activeViewId.get(),
        },
        ...metadata,
      },
    });
  }
}

export function buildOpenAssistantButton(
  gristDoc: GristDoc,
  ...args: DomElementArg[]
) {
  const { assistant } = getGristConfig();
  if (!assistant || assistant.version === 1) {
    return null;
  }

  return cssPageEntry(
    cssPageLink(
      cssPageIcon("Robot"),
      cssLinkText(t("Assistant")),
      dom.on("click", () => commands.allCommands.activateAssistant.run()),
      dom.cls("tour-assistant"),
      ...args
    )
  );
}

async function askAI(
  grist: GristDoc,
  options: {
    description: string;
    conversationId: string;
    developerPromptVersion: DeveloperPromptVersion;
    state?: AssistanceState;
  }
) {
  const { description, conversationId, developerPromptVersion, state } = options;
  const viewId = grist.activeViewId.get();
  return await grist.docApi.getAssistance({
    conversationId,
    context: {
      viewId: typeof viewId === "number" ? viewId : undefined,
    },
    text: description,
    developerPromptVersion,
    state,
  });
}

function buildIntroMessage(...args: DomElementArg[]) {
  return cssAiIntroMessage(
    cssAvatar(cssAiImage()),
    dom("div",
      cssAiMessageParagraph(t("Hi, I'm the Grist AI Assistant.")),
      cssAiMessageParagraph(
        t("Some things you should know when working with me:")
      ),
      cssAiMessageList(
        cssAiMessageListItem(
          inlineMarkdown(
            t(
              "I **can** answer questions about your data, create or modify " +
                "tables, pages, and most widgets. I can link widgets and help " +
                "with formulas. I also know which page you're viewing."
            )
          )
        ),
        cssAiMessageListItem(
          inlineMarkdown(
            t(
              "I **can't** create or modify charts, forms, access rules, or " +
                "modify page layout. I also don't know if you've selected something."
            )
          )
        ),
        cssAiMessageListItem(
          t(
            'Talk to me like a person. For example, "What were the top ' +
              '3 months for gross revenue in the last year?"'
          )
        ),
        getGristConfig().assistant?.provider === "OpenAI"
          ? cssAiMessageListItem(
              dom("div",
                t(
                  "When you talk to me, your questions, document structure, " +
                    "and data are sent to OpenAI. {{learnMore}}",
                  {
                    learnMore: cssLink(t("Learn more."), {
                      href: commonUrls.helpAssistantDataUse,
                      target: "_blank",
                    }),
                  }
                )
              )
            )
          : null
      ),
    ),
    ...args,
  );
}

const cssPopupTitle = styled("div", `
  display: flex;
  align-items: center;
  column-gap: 8px;
  user-select: none;
`);

const cssPopupContent = styled("div", `
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
`);

const cssToolbar = styled("div", `
  display: flex;
  justify-content: flex-end;
  align-items: center;
  flex-shrink: 0;
  height: 30px;
  padding: 0px 8px 0px 8px;
  background-color: ${theme.formulaAssistantHeaderBg};
  border-top: 1px solid ${theme.formulaAssistantBorder};
  border-bottom: 1px solid ${theme.formulaAssistantBorder};
`);

const cssToolbarButtons = styled("div", `
  display: flex;
  align-items: center;
  column-gap: 8px;
`);

const cssToolbarButton = styled("div", `
  --icon-color: ${theme.controlSecondaryFg};
  border-radius: 3px;
  padding: 3px;
  cursor: pointer;
  user-select: none;

  &:hover, &.weasel-popup-open {
    background-color: ${theme.hover};
  }
`);

const cssChatOptionsMenu = styled("div", `
  z-index: ${vars.floatingPopupMenuZIndex};
`);

const cssAssistant = styled("div", `
  overflow: hidden;
  display: flex;
  flex-direction: column;
  flex-grow: 1;
`);

const cssAiMessageList = styled("ul", `
  margin-bottom: 8px;
`);

const cssAiMessageListItem = styled("li", `
  margin-bottom: 8px;
`);
