import type {AppModel} from 'app/client/models/AppModel';
import {PlanSelection} from 'app/common/BillingAPI';
import { commonUrls } from 'app/common/gristUrls';
import {Disposable} from 'grainjs';
import * as CoreTeamModals from "app/client/ui/CreateTeamModal";
import {createEnterpriseSpecificFunc} from "app/client/lib/enterpriseDeploymentCheck";

export const buildNewSiteModal = CoreTeamModals.buildNewSiteModal;

async function buildEnterpriseUpgradeModal(owner: Disposable, options: {
  appModel: AppModel,
  pickPlan?: PlanSelection,
  reason?: 'upgrade' | 'renew',
})  {
  window.location.href = commonUrls.plans;
}

export const buildUpgradeModal = createEnterpriseSpecificFunc(
    buildEnterpriseUpgradeModal,
    CoreTeamModals.buildUpgradeModal,
);

export const buildUpgradeButton = CoreTeamModals.buildUpgradeButton;
