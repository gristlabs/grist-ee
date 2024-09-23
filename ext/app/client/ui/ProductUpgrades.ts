import {createEnterpriseSpecificFunc} from 'app/client/lib/enterpriseDeploymentCheck';
import type {AppModel} from 'app/client/models/AppModel';
import {buildUpgradeModal as buildCoreUpgradeModal} from 'app/client/ui/CreateTeamModal';
import {PlanSelection} from 'app/common/BillingAPI';
import {commonUrls} from 'app/common/gristUrls';
import {Disposable} from 'grainjs';

async function buildEnterpriseUpgradeModal(_owner: Disposable, _options: {
  appModel: AppModel,
  pickPlan?: PlanSelection,
  reason?: 'upgrade' | 'renew',
})  {
  window.location.href = commonUrls.plans;
}

export const buildUpgradeModal = createEnterpriseSpecificFunc(
  buildEnterpriseUpgradeModal,
  buildCoreUpgradeModal
);

export {buildNewSiteModal, UpgradeButton} from 'app/client/ui/CreateTeamModal';
