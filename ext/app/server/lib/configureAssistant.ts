import { AssistantVersion } from "app/common/Assistant";
import { appSettings } from "app/server/lib/AppSettings";
import { configureOpenAIAssistantV1 } from "app/server/lib/configureOpenAIAssistantV1";
import { configureOpenAIAssistantV2 } from "app/server/lib/configureOpenAIAssistantV2";
import { IAssistant } from "app/server/lib/IAssistant";

export function configureAssistant(): IAssistant | undefined {
  const version = appSettings
    .section("assistant")
    .flag("version")
    .readInt({
      envVar: "GRIST_TEST_ASSISTANT_VERSION",
      defaultValue: 2,
      minValue: 1,
      maxValue: 2,
    }) as AssistantVersion;
  switch (version) {
    case 1: {
      return configureOpenAIAssistantV1();
    }
    case 2: {
      return configureOpenAIAssistantV2();
    }
  }
}
