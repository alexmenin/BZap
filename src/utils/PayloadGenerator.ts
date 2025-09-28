import { createHash } from 'crypto';
import { waproto } from '@wppconnect/wa-proto';
import { AUTH_CONFIG } from '../constants/Constants';

/**
 * Tipos para as credenciais de autenticação
 */
export interface SignalCreds {
  readonly signedIdentityKey: {
    public: Uint8Array;
    private: Uint8Array;
  };
  readonly signedPreKey: {
    keyPair: {
      public: Uint8Array;
      private: Uint8Array;
    };
    signature: Uint8Array;
    keyId: number;
    timestampS?: number;
  };
  readonly registrationId: number;
}

export interface SocketConfig {
  browser: [string, string, string];
  version: [number, number, number];
  syncFullHistory?: boolean;
  countryCode?: string;
}

/**
 * Codifica um número em big-endian com o tamanho especificado
 * Implementação baseada no Baileys para compatibilidade
 */
function encodeBigEndian(e: number, t: number = 4): Uint8Array {
  let r = e;
  const a = new Uint8Array(t);
  for (let i = t - 1; i >= 0; i--) {
    a[i] = 255 & r;
    r >>>= 8;
  }
  return a;
}

/**
 * Obtém informações do User Agent
 * Implementação baseada no Baileys para compatibilidade
 */
function getUserAgent(config: SocketConfig): waproto.ClientPayload.IUserAgent {
  return {
    appVersion: {
      primary: config.version[0],
      secondary: config.version[1],
      tertiary: config.version[2]
    },
    platform: waproto.ClientPayload.UserAgent.Platform.WEB,
    releaseChannel: waproto.ClientPayload.UserAgent.ReleaseChannel.RELEASE,
    osVersion: '0.1',
    device: 'Desktop',
    osBuildNumber: '0.1',
    localeLanguageIso6391: 'en',
    mnc: '000',
    mcc: '000',
    localeCountryIso31661Alpha2: config.countryCode || 'BR'
  };
}

/**
 * Mapeia plataformas para tipos do protobuf
 */
const PLATFORM_MAP = {
  'Mac OS': waproto.ClientPayload.WebInfo.WebSubPlatform.DARWIN,
  'Windows': waproto.ClientPayload.WebInfo.WebSubPlatform.WIN32
};

/**
 * Obtém informações da Web
 */
function getWebInfo(config: SocketConfig): waproto.ClientPayload.IWebInfo {
  let webSubPlatform = waproto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER;
  if (config.syncFullHistory && PLATFORM_MAP[config.browser[0] as keyof typeof PLATFORM_MAP]) {
    webSubPlatform = PLATFORM_MAP[config.browser[0] as keyof typeof PLATFORM_MAP];
  }
  
  return { webSubPlatform };
}

/**
 * Obtém o payload base do cliente
 */
function getClientPayload(config: SocketConfig): waproto.IClientPayload {
  const payload: waproto.IClientPayload = {
    connectType: waproto.ClientPayload.ConnectType.WIFI_UNKNOWN,
    connectReason: waproto.ClientPayload.ConnectReason.USER_ACTIVATED,
    userAgent: getUserAgent(config)
  };
  
  payload.webInfo = getWebInfo(config);
  
  return payload;
}

/**
 * Obtém o tipo de plataforma
 */
function getPlatformType(platform: string): waproto.DeviceProps.PlatformType {
  const platformType = platform.toUpperCase();
  return (
    waproto.DeviceProps.PlatformType[platformType as keyof typeof waproto.DeviceProps.PlatformType] ||
    waproto.DeviceProps.PlatformType.DESKTOP
  );
}

/**
 * Gera o nó de login para usuários já autenticados
 */
export function generateLoginNode(userJid: string, config: SocketConfig): waproto.IClientPayload {
  // Extrai user e device do JID (formato: user@s.whatsapp.net:device)
  const jidParts = userJid.split('@')[0].split(':');
  const user = jidParts[0];
  const device = jidParts[1] ? parseInt(jidParts[1]) : 0;
  
  const payload: waproto.IClientPayload = {
    ...getClientPayload(config),
    passive: false,
    pull: true,
    username: parseInt(user),
    device: device
  };
  
  return waproto.ClientPayload.create(payload);
}

/**
 * Gera o nó de registro para novos dispositivos
 */
export function generateRegistrationNode(
  creds: SignalCreds,
  config: SocketConfig
): waproto.IClientPayload {
  // Hash MD5 da versão da aplicação
  const appVersionBuf = createHash('md5')
    .update(config.version.join('.'))
    .digest();
  
  // Propriedades do dispositivo companion
  const companion: waproto.IDeviceProps = {
    os: config.browser[0],
    platformType: getPlatformType(config.browser[1]),
    requireFullSync: config.syncFullHistory || false
  };
  
  const companionProto = waproto.DeviceProps.encode(companion).finish();
  
  // Tipo de bundle de chaves (constante do Baileys) - deve ser Buffer, não Uint8Array
  const KEY_BUNDLE_TYPE = AUTH_CONFIG.KEY_BUNDLE_TYPE;
  
  const registerPayload: waproto.IClientPayload = {
    ...getClientPayload(config),
    passive: false,
    pull: false,
    devicePairingData: {
      buildHash: appVersionBuf,
      deviceProps: companionProto,
      eRegid: encodeBigEndian(creds.registrationId),
      eKeytype: KEY_BUNDLE_TYPE,
      eIdent: creds.signedIdentityKey.public,
      eSkeyId: encodeBigEndian(creds.signedPreKey.keyId, 3),
      eSkeyVal: creds.signedPreKey.keyPair.public,
      eSkeySig: creds.signedPreKey.signature
    }
  };
  
  return waproto.ClientPayload.create(registerPayload);
}

/**
 * Cria o payload de autenticação baseado nas credenciais
 */
export function createAuthPayload(
  creds: any,
  config: SocketConfig
): waproto.IClientPayload {
  console.log('🔍 Analisando credenciais para payload:', {
    hasMe: !!creds.me,
    hasSignedIdentityKey: !!creds.signedIdentityKey,
    hasSignedPreKey: !!creds.signedPreKey,
    hasRegistrationId: !!creds.registrationId,
    credentialsKeys: Object.keys(creds)
  });
  
  // Se já tem informações do usuário (me), usa login
  if (creds.me) {
    console.log('📱 Gerando payload de login para usuário existente:', creds.me.id);
    return generateLoginNode(creds.me.id, config);
  } else {
    console.log('🆕 Gerando payload de registro para novo dispositivo');
    
    // Converte credenciais do Baileys para o formato esperado
    const signalCreds: SignalCreds = {
      signedIdentityKey: {
        public: creds.signedIdentityKey?.public || new Uint8Array(),
        private: creds.signedIdentityKey?.private || new Uint8Array()
      },
      signedPreKey: {
        keyPair: {
          public: creds.signedPreKey?.keyPair?.public || new Uint8Array(),
          private: creds.signedPreKey?.keyPair?.private || new Uint8Array()
        },
        signature: creds.signedPreKey?.signature || new Uint8Array(),
        keyId: creds.signedPreKey?.keyId || 0,
        timestampS: creds.signedPreKey?.timestampS
      },
      registrationId: creds.registrationId || 0
    };
    
    console.log('✅ Credenciais convertidas:', {
      hasPublicKey: signalCreds.signedIdentityKey.public.length > 0,
      hasPreKeyPublic: signalCreds.signedPreKey.keyPair.public.length > 0,
      registrationId: signalCreds.registrationId
    });
    
    return generateRegistrationNode(signalCreds, config);
  }
}