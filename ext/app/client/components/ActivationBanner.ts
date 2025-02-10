import {Banner, BannerOptions, buildBannerMessage} from 'app/client/components/Banner';
import {makeT} from 'app/client/lib/localization';
import {AppModel} from 'app/client/models/AppModel';
import {commonUrls} from 'app/common/gristUrls';
import {getGristConfig} from 'app/common/urlUtils';
import {markdown as markdownBase} from 'app/client/lib/markdown';
import {dom, DomElementArg, makeTestId, styled} from 'grainjs';

const t = makeT("ActivationBanner");

const testId = makeTestId("test-activation-banner-");

export function buildActivationBanner(app: AppModel) {
  // Only administrators, owners, and editors of team sites will see banners.
  // Viewers and guests should not see any banner.
  if (!(app.isInstallAdmin() || app.isOwnerOrEditor())) {
    return null;
  }

  // We need activation info, otherwise we don't know what to show.
  const {activation} = getGristConfig();
  if (!activation) {
    return null;
  }



  if (activation.trial && activation.trial.daysLeft > 0) {
    // Seen only by installation admin.
    if (app.isInstallAdmin()) {
      return trialBanner(activation.trial.daysLeft);
    } else {
      return null;
    }
  } else if (activation.needKey) {
    return needKeyBanner(app);
  } else if (activation.grace?.daysLeft && activation.grace?.daysLeft > 0) {
    return graceBanner(app, activation.grace.daysLeft);
  } else if (!activation.needKey && activation.key?.daysLeft && activation.key?.daysLeft < 30) {
    return approachingBanner(app, activation.key.daysLeft);
  } else {
    return null;
  }
}

function buildBanner(message: DomElementArg, style: BannerOptions['style']) {
  return dom.create(Banner, {
    content: buildBannerMessage(message, testId('text')),
    style,
    showCloseButton: false,
    showExpandButton: false,
  });
}

function graceBanner(app: AppModel, daysLeft: number) {
  if (getGristConfig().activation?.features?.installationNoGraceBanner) {
    return null;
  }

  // We might be in a grace period because key has expired or limits have been exceeded.
  const {activation} = getGristConfig();
  if (activation?.key?.daysLeft === 0) {
    const contactUs = url(commonUrls.contact)
      .add("subject", "Key has expired")
      .add("installationId", getGristConfig().activation?.installationId)
      .toString();

    if (app.isInstallAdmin()) {
      return buildBanner(
        markdown(t(`Your activation key has expired. Documents will be in read-only mode
        in ${daysLeft} day(s). [Contact us]({{contactUs}}) to get a new key.`,
          {
            daysLeft,
            contactUs,
          }
        )),
        "warning"
      );
    } else {
      return buildBanner(
        markdown(t(`Your subscription has expired. Documents will be in read-only mode
        in ${daysLeft} day(s). [Contact us]({{contactUs}}) to renew your plan.`,
          {
            daysLeft,
            contactUs,
          }
        )),
        "warning"
      );
    }
  } else {
    const contactUs = url(commonUrls.contact)
      .add("subject", "User Limit Exceeded")
      .add("installationId", getGristConfig().activation?.installationId)
      .toString();

    // User limit is exceeded, same banner for admin and owners/editors
    return buildBanner(
      markdown(t(`The user limit has been exceeded. Documents will be in read-only mode
      in ${daysLeft} day(s). [Contact us]({{contactUs}}) to add more users to your plan.`,
        {
          daysLeft,
          contactUs,
        }
      )),
      "warning"
    );
  }
}


function approachingBanner(app: AppModel, daysLeft: number) {
  const contactUs = url(commonUrls.contact)
    .add("subject", "Key will expire soon")
    .add("installationId", getGristConfig().activation?.installationId)
    .toString();
  if (app.isInstallAdmin()) {
    return buildBanner(
      markdown(t(`A new activation key will be required in {{- daysLeft}} day(s) to continue
using subscription-only features. [Contact us]({{contactUs}}) to get a new key.`,
        {
          daysLeft,
          contactUs,
        }
      )),
      "warning"
    );
  } else {
    return buildBanner(
      markdown(t(`Subscription will expire in {{- daysLeft}} day(s). To continue
using subscription-only features [Contact us]({{contactUs}}).`,
        {
          daysLeft,
          contactUs,
        }
      )),
      "warning"
    );
  }
}

function trialBanner(daysLeft: number) {
  const contactUs = url(commonUrls.contact)
    .add("subject", "Trial Expiration Warning")
    .add("installationId", getGristConfig().activation?.installationId)
    .toString();

  return buildBanner(
    markdown(t(`Trial: {{- daysLeft}} day(s) left. [Contact us]({{contactUs}}) to activate today.`,
      {
        daysLeft,
        contactUs,
      }
    )),
    "warning"
  );
}

function needKeyBanner(app: AppModel) {

  const contactUs = url(commonUrls.contact)
    .add("subject", "Activation Key Needed")
    .add("installationId", getGristConfig().activation?.installationId)
    .toString();

  if (app.isInstallAdmin()) {
    return buildBanner(
      markdown(t(`Activation key needed. Documents in read-only mode. [Contact us]({{contactUs}}) to get a key.`,
        {
          contactUs,
        }
      )),
      "error"
    );
  } else {
    return buildBanner(
      markdown(t(`Subscription expired. Documents in read-only mode. [Contact us]({{contactUs}}) to renew your plan.`,
        {
          contactUs,
        }
      )),
      "error"
    );
  }
}

const cssInline = styled('span', `
  display: inline;
  & p {
    display: inline;
  }
  & a {
    color: unset;
    text-decoration: underline;

    &:hover, &:focus {
      color: unset;
    }
  }
`);

const markdown = (text: string) => cssInline(markdownBase(text));

/** Helper object to build URL in a fluent way */
const url = (text: string) => {
  return {
    list: [] as [string, string][],
    add(key: string, value: any) {
      this.list.push([key, value]);
      return this;
    },
    toString() {
      const link = new URL(text);
      this.list.forEach(([key, value]) => link.searchParams.set(key, String(value ?? '')));
      return link.toString();
    }
  };
};
