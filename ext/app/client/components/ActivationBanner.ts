import {Banner, BannerOptions, buildBannerMessage} from 'app/client/components/Banner';
import {getGristConfig} from 'app/common/urlUtils';
import {dom, makeTestId} from 'grainjs';

const testId = makeTestId('test-activation-banner-');

export function buildActivationBanner() {
  const {activation} = getGristConfig();
  if (activation?.trial) {
    return buildBanner(`Trial: ${activation.trial.daysLeft} day(s) left.`, 'warning');
  } else if (activation?.needKey) {
    return buildBanner('Activation key needed. Documents in read-only mode.', 'error');
  } else if (activation?.key?.daysLeft && activation?.key.daysLeft < 30) {
    return buildBanner(`Need reactivation in ${activation.key.daysLeft} day(s).`, 'warning');
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
