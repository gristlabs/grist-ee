import { getForwardAuthLoginSystem } from 'app/server/lib/ForwardAuthLogin';
import { GristLoginSystem } from 'app/server/lib/GristServer';
import { getMinimalLoginSystem } from 'app/server/lib/MinimalLogin';
import { getSamlLoginSystem } from 'app/server/lib/SamlConfig';
import { getConnectLoginSystem } from 'app/server/lib/GristConnect';
import { isRunningEnterprise } from "app/server/lib/ActivationReader";
import { getCoreLoginSystem } from 'app/server/lib/coreLogins';

export async function getEnterpriseLoginSystem(): Promise<GristLoginSystem> {
  return await getSamlLoginSystem() ||
    await getForwardAuthLoginSystem() ||
    await getConnectLoginSystem() ||
    await getMinimalLoginSystem();
}

export const getLoginSystem: () => Promise<GristLoginSystem> =
    isRunningEnterprise() ? getEnterpriseLoginSystem : getCoreLoginSystem;
