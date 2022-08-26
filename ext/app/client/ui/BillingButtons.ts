import {AppModel} from 'app/client/models/AppModel';
import {urlState} from 'app/client/models/gristUrlState';
import {menuItemLink} from 'app/client/ui2018/menus';
import {getGristConfig} from 'app/common/urlUtils';
import {DomElementArg} from 'grainjs';

export function buildUserMenuBillingItem(appModel: AppModel, ...args: DomElementArg[]) {
  return buildActivationMenuItem(appModel, args);
}

export function buildAppMenuBillingItem(appModel: AppModel, ...args: DomElementArg[]) {
  return buildActivationMenuItem(appModel, args);
}

function buildActivationMenuItem(appModel: AppModel, ...args: DomElementArg[]) {
  const {activation} = getGristConfig();

  return !activation?.isManager ? null : menuItemLink(
    urlState().setLinkUrl({activation: 'activation'}), 'Activation', ...args
  );
}
