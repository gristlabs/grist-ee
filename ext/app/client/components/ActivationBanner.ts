import {
  Banner,
  BannerOptions,
  buildBannerMessage,
} from "app/client/components/Banner";
import { makeT } from "app/client/lib/localization";
import { cssLink } from "app/client/ui2018/links";
import { commonUrls } from "app/common/gristUrls";
import { getGristConfig } from "app/common/urlUtils";
import { dom, makeTestId, styled } from "grainjs";

const t = makeT("ActivationBanner");

const testId = makeTestId("test-activation-banner-");

export function buildActivationBanner() {
  const { activation } = getGristConfig();
  if (activation?.trial) {
    return buildBanner(
      t(
        "Trial: {{- daysLeft}} day(s) left. {{contactUs}} to activate today.",
        {
          daysLeft: activation.trial.daysLeft,
          contactUs: cssBannerLink(
            { href: commonUrls.contact, target: "_blank" },
            t("Contact us")
          ),
        }
      ),
      "warning"
    );
  } else if (activation?.needKey) {
    return buildBanner(
      t(
        "Activation key needed. Documents in read-only mode. {{contactUs}} to get a key.",
        {
          contactUs: cssBannerLink(
            { href: commonUrls.contact, target: "_blank" },
            t("Contact us")
          ),
        }
      ),
      "error"
    );
  } else if (activation?.key?.daysLeft && activation?.key.daysLeft < 30) {
    return buildBanner(
      t(
        "A new activation key will be required in {{- daysLeft}} day(s) to continue using " +
          "subscription-only features. {{contactUs}} to get a new key.",
        {
          daysLeft: activation.key.daysLeft,
          contactUs: cssBannerLink(
            { href: commonUrls.contact, target: "_blank" },
            t("Contact us")
          ),
        }
      ),
      "warning"
    );
  } else {
    return null;
  }
}

function buildBanner(message: string, style: BannerOptions['style']) {
  return dom.create(Banner, {
    content: buildBannerMessage(message, testId('text')),
    style,
    showCloseButton: false,
    showExpandButton: false,
  });
}

const cssBannerLink = styled(cssLink, `
  color: unset;
  text-decoration: underline;

  &:hover, &:focus {
    color: unset;
  }
`);
