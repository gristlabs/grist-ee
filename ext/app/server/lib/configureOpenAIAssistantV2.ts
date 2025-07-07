import { getAssistantV2Options } from "app/server/lib/Assistant";
import { GristServer } from "app/server/lib/GristServer";
import { AssistantV2 } from "app/server/lib/IAssistant";
import {
  EchoAssistantV2,
  OpenAIAssistantV2,
} from "app/server/lib/OpenAIAssistantV2";

export function configureOpenAIAssistantV2(
  gristServer: GristServer
): AssistantV2 | undefined {
  const options = getAssistantV2Options();
  if (!options.apiKey && !options.completionEndpoint) {
    return undefined;
  } else if (options.apiKey === "test") {
    return new EchoAssistantV2();
  } else {
    return new OpenAIAssistantV2(gristServer, options);
  }
}
