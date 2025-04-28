import { getAssistantV2Options } from "app/server/lib/Assistant";
import { AssistantV2 } from "app/server/lib/IAssistant";
import { EchoAssistantV2, OpenAIAssistantV2 } from "app/server/lib/OpenAIAssistantV2";

export function configureOpenAIAssistantV2(): AssistantV2 | undefined {
  const options = getAssistantV2Options();
  if (!options.apiKey && !options.completionEndpoint) {
    return undefined;
  } else if (options.apiKey === "test") {
    return new EchoAssistantV2();
  } else {
    return new OpenAIAssistantV2(options);
  }
}
