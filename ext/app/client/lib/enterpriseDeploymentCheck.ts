import { GristDeploymentType } from "app/common/gristUrls";
import { getGristConfig } from "app/common/urlUtils";

const enterpriseDeploymentTypes: GristDeploymentType[] = ['saas', 'enterprise'];
export function isEnterpriseDeployment(): boolean {
    return enterpriseDeploymentTypes.includes(getGristConfig().deploymentType ?? 'core');
}

/**
 * Calls one of the provided callbacks at call time, based on the edition of grist that's running.
 * @param enterpriseCallback - Called when an enterprise deployment type is used.
 * @param nonEnterpriseCallback - Called for non-enterprise deployment types (e.g. core, desktop).
 */
export function createEnterpriseSpecificFunc<P extends any[], R>(
    enterpriseCallback: (...args: P) => R,
    nonEnterpriseCallback: (...args: P) => R
)
{
    return function callCorrectCallback(...args: P): R {
        return isEnterpriseDeployment() ? enterpriseCallback(...args) : nonEnterpriseCallback(...args);
    };
}
