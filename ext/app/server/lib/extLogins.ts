import {AppSettings} from 'app/server/lib/AppSettings';
import {getForwardAuthLoginSystem} from 'app/server/lib/ForwardAuthLogin';
import {getConnectLoginSystem} from 'app/server/lib/GristConnect';
import {GristLoginSystem} from 'app/server/lib/GristServer';
import {getMinimalLoginSystem, getNoLoginSystem} from 'app/server/lib/MinimalLogin';
import {getOIDCLoginSystem} from 'app/server/lib/OIDCConfig';
import {getSamlLoginSystem} from 'app/server/lib/SamlConfig';

export async function getExtLoginSystem(settings: AppSettings): Promise<GristLoginSystem> {
  return await getConnectLoginSystem(settings) ||
    await getSamlLoginSystem(settings) ||
    await getOIDCLoginSystem(settings) ||
    await getForwardAuthLoginSystem(settings) ||
    await getMinimalLoginSystem(settings) ||
    await getNoLoginSystem();
}
