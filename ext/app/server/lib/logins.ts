import { getForwardAuthLoginSystem } from 'app/server/lib/ForwardAuthLogin';
import { GristLoginSystem } from 'app/server/lib/GristServer';
import { getMinimalLoginSystem } from 'app/server/lib/MinimalLogin';
import { getSamlLoginSystem } from 'app/server/lib/SamlConfig';
import { getConnectLoginSystem } from 'app/server/lib/GristConnect';

export async function getLoginSystem(): Promise<GristLoginSystem> {
  return await getSamlLoginSystem() ||
    await getForwardAuthLoginSystem() ||
    await getConnectLoginSystem() ||
    await getMinimalLoginSystem();
}
