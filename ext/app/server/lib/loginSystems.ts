import {
  FORWARDAUTH_PROVIDER_KEY,
  GRIST_CONNECT_PROVIDER_KEY,
  OIDC_PROVIDER_KEY,
  SAML_PROVIDER_KEY
} from 'app/common/loginProviders';
import {readForwardAuthConfigFromSettings} from 'app/server/lib/ForwardAuthLogin';
import {readGristConnectConfigFromSettings} from 'app/server/lib/GristConnect';
import {LoginSystemConfig} from 'app/server/lib/LoginSystemConfig';
import {readOIDCConfigFromSettings} from 'app/server/lib/OIDCConfig';
import {readSamlConfigFromSettings} from 'app/server/lib/SamlConfig';

export const LOGIN_SYSTEMS: LoginSystemConfig[] = [
  { key: OIDC_PROVIDER_KEY, name: 'OIDC', reader: readOIDCConfigFromSettings },
  { key: SAML_PROVIDER_KEY, name: 'SAML', reader: readSamlConfigFromSettings },
  { key: FORWARDAUTH_PROVIDER_KEY, name: 'Forwarded headers', reader: readForwardAuthConfigFromSettings },
  { key: GRIST_CONNECT_PROVIDER_KEY, name: 'Grist Connect', reader: readGristConnectConfigFromSettings },
];
