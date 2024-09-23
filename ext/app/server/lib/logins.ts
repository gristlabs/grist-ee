import { GristLoginSystem } from 'app/server/lib/GristServer';
import { getConnectLoginSystem } from 'app/server/lib/GristConnect';
import { getCoreLoginSystem } from "app/server/lib/coreLogins";

export async function getLoginSystem(): Promise<GristLoginSystem> {
  return await getConnectLoginSystem() ||
    await getCoreLoginSystem();
}
