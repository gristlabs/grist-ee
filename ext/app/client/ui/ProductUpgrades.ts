import type {AppModel} from 'app/client/models/AppModel';
import {PlanSelection} from 'app/common/BillingAPI';
import {commonUrls} from 'app/common/gristUrls';
import {Disposable, DomArg, DomContents, IDisposableOwner} from 'grainjs';

export async function buildNewSiteModal(context: Disposable, options: {
  appModel: AppModel,
  plan?: PlanSelection,
  onCreate?: () => void
}) {
  window.location.href = commonUrls.plans;
}

export async function buildUpgradeModal(owner: Disposable, options: {
  appModel: AppModel,
  pickPlan?: PlanSelection,
  reason?: 'upgrade' | 'renew',
})  {
  window.location.href = commonUrls.plans;
}

export function showTeamUpgradeConfirmation(owner: Disposable) {
}

export interface UpgradeButton  {
  showUpgradeCard(...args: DomArg<HTMLElement>[]): DomContents;
  showUpgradeButton(...args: DomArg<HTMLElement>[]): DomContents;
}

export function buildUpgradeButton(owner: IDisposableOwner, app: AppModel): UpgradeButton {
  return {
    showUpgradeCard : () => null,
    showUpgradeButton : () => null,
  };
}
