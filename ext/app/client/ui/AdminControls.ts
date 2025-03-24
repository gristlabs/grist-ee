import {createEnterpriseSpecificFunc} from 'app/client/lib/enterpriseDeploymentCheck';
import {
  buildAdminData as buildAdminDataExt,
  buildLeftPanel as buildLeftPanelExt,
} from 'app/client/ui/AdminControlsExt';

import {
  buildAdminData as buildAdminDataCore,
  buildLeftPanel as buildLeftPanelCore,
} from 'app/client/ui/AdminControlsCore';

export const buildLeftPanel = createEnterpriseSpecificFunc(
  buildLeftPanelExt,
  buildLeftPanelCore,
);

export const buildAdminData = createEnterpriseSpecificFunc(
  buildAdminDataExt,
  buildAdminDataCore,
);
