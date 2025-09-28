import { Boom } from '@hapi/boom';
import { createHash } from 'crypto';
import { waproto } from '@wppconnect/wa-proto';
import { AuthenticationCreds } from '../auth/AuthStateManager';
import { Curve } from '../crypto/Curve25519';

/**
 * Configuração de pareamento bem-sucedido
 * Baseado na implementação original do Baileys
 */
export const configureSuccessfulPairing = (
  stanza: any,
  creds: Pick<AuthenticationCreds, 'advSecretKey' | 'signedIdentityKey' | 'signalIdentities'>
) => {
  const msgId = stanza.attrs.id;

  const pairSuccessNode = getBinaryNodeChild(stanza, 'pair-success');

  const deviceIdentityNode = getBinaryNodeChild(pairSuccessNode, 'device-identity');
  const platformNode = getBinaryNodeChild(pairSuccessNode, 'platform');
  const deviceNode = getBinaryNodeChild(pairSuccessNode, 'device');
  const businessNode = getBinaryNodeChild(pairSuccessNode, 'biz');

  if (!deviceIdentityNode || !deviceNode) {
    throw new Boom('Missing device-identity or device in pair success node', { data: stanza });
  }

  const bizName = businessNode?.attrs.name;
  const jid = deviceNode.attrs.jid;
  const lid = deviceNode.attrs.lid;

  const { details, hmac, accountType } = waproto.ADVSignedDeviceIdentityHMAC.decode(deviceIdentityNode.content as Buffer);
  const isHostedAccount = accountType !== undefined && accountType === waproto.ADVEncryptionType.HOSTED;

  const hmacPrefix = isHostedAccount ? Buffer.from([6, 5]) : Buffer.alloc(0);
  const detailsBuffer = Buffer.from(details || []);
  const hmacBuffer = Buffer.from(hmac || []);
  const advSign = hmacSign(Buffer.concat([hmacPrefix, detailsBuffer]), Buffer.from(creds.advSecretKey, 'base64'));
  if (Buffer.compare(hmacBuffer, advSign) !== 0) {
    throw new Boom('Invalid ADV signature');
  }

  const account = waproto.ADVSignedDeviceIdentity.decode(detailsBuffer);
  const accountSignatureKey = account.accountSignatureKey || Buffer.alloc(0);
  const accountSignature = account.accountSignature || Buffer.alloc(0);
  const deviceDetails = account.details || Buffer.alloc(0);
  const accountMsg = Buffer.concat([Buffer.from([6, 0]), Buffer.from(deviceDetails), creds.signedIdentityKey.public]);
  if (!Curve.verify(Buffer.from(accountSignatureKey), accountMsg, Buffer.from(accountSignature))) {
    throw new Boom('Failed to verify account signature');
  }

  const devicePrefix = isHostedAccount ? Buffer.from([6, 6]) : Buffer.from([6, 1]);
  const deviceMsg = Buffer.concat([devicePrefix, Buffer.from(deviceDetails), creds.signedIdentityKey.public, Buffer.from(accountSignatureKey)]);
  account.deviceSignature = Curve.sign(creds.signedIdentityKey.private, deviceMsg);

  const identity = createSignalIdentity(lid!, Buffer.from(accountSignatureKey));
  const accountEnc = encodeSignedDeviceIdentity(account, false);

  // Decodifica a identidade do dispositivo
  const deviceIdentityBuffer = typeof account.details === 'string' 
    ? Buffer.from(account.details, 'base64') 
    : Buffer.from(account.details || []);
  const deviceIdentity = waproto.ADVDeviceIdentity.decode(deviceIdentityBuffer);

  const reply: any = {
    tag: 'iq',
    attrs: {
      to: 's.whatsapp.net',
      type: 'result',
      id: msgId!
    },
    content: [
      {
        tag: 'pair-device-sign',
        attrs: {},
        content: [
          {
            tag: 'device-identity',
            attrs: { 'key-index': (deviceIdentity.keyIndex || 0).toString() },
            content: accountEnc
          }
        ]
      }
    ]
  };

  const authUpdate: Partial<AuthenticationCreds> = {
    account: {
      details: Buffer.isBuffer(account.details) ? account.details.toString('base64') : (typeof account.details === 'string' ? account.details : Buffer.from(account.details || []).toString('base64')),
      accountSignatureKey: Buffer.isBuffer(account.accountSignatureKey) ? account.accountSignatureKey.toString('base64') : (typeof account.accountSignatureKey === 'string' ? account.accountSignatureKey : Buffer.from(account.accountSignatureKey || []).toString('base64')),
      accountSignature: Buffer.isBuffer(account.accountSignature) ? account.accountSignature.toString('base64') : (typeof account.accountSignature === 'string' ? account.accountSignature : Buffer.from(account.accountSignature || []).toString('base64')),
      deviceSignature: Buffer.isBuffer(account.deviceSignature) ? account.deviceSignature.toString('base64') : (typeof account.deviceSignature === 'string' ? account.deviceSignature : Buffer.from(account.deviceSignature || []).toString('base64'))
    },
    me: { id: jid!, name: bizName, lid },
    signalIdentities: [...(creds.signalIdentities || []), identity],
    platform: platformNode?.attrs.name
  };

  return {
    creds: authUpdate,
    reply
  };
};

/**
 * Codifica identidade de dispositivo assinada
 */
export const encodeSignedDeviceIdentity = (account: any, includeSignatureKey: boolean) => {
  account = { ...account };
  // set to null if we are not to include the signature key
  // or if we are including the signature key but it is empty
  if (!includeSignatureKey || !account.accountSignatureKey?.length) {
    account.accountSignatureKey = null;
  }

  return waproto.ADVSignedDeviceIdentity.encode(account).finish();
};

/**
 * Cria identidade Signal
 */
export const createSignalIdentity = (lid: string, accountSignatureKey: Buffer) => {
  return {
    identifier: { name: lid, deviceId: 0 },
    identifierKey: accountSignatureKey
  };
};

/**
 * Assina HMAC
 */
export const hmacSign = (data: Buffer, key: Buffer) => {
  const crypto = require('crypto');
  return crypto.createHmac('sha256', key).update(data).digest();
};

/**
 * Obtém nó filho binário
 */
export const getBinaryNodeChild = (node: any, tag: string): any => {
  if (!node?.content || !Array.isArray(node.content)) {
    return null;
  }
  
  return node.content.find((child: any) => child.tag === tag);
};

/**
 * Obtém nós filhos binários
 */
export const getBinaryNodeChildren = (node: any, tag: string): any[] => {
  if (!node?.content || !Array.isArray(node.content)) {
    return [];
  }
  
  return node.content.filter((child: any) => child.tag === tag);
};

/**
 * Gera nó de login
 */
export const generateLoginNode = (userJid: string, config: any): any => {
  // Decodifica o JID para extrair user e device
  const sepIdx = userJid.indexOf('@');
  if (sepIdx < 0) {
    throw new Error('Invalid JID format');
  }
  
  const userCombined = userJid.slice(0, sepIdx);
  const [userAgent, deviceStr] = userCombined.split(':');
  const user = userAgent.split('_')[0];
  const device = deviceStr ? parseInt(deviceStr, 10) : undefined;

  const payload = {
    connectType: waproto.ClientPayload.ConnectType.WIFI_UNKNOWN,
    connectReason: waproto.ClientPayload.ConnectReason.USER_ACTIVATED,
    userAgent: getUserAgent(config),
    webInfo: getWebInfo(config),
    username: parseInt(user, 10),
    device: device,
    passive: false,
    pull: true
  };

  return waproto.ClientPayload.create(payload);
};

// Constante KEY_BUNDLE_TYPE como no Baileys original
const KEY_BUNDLE_TYPE = Buffer.from([5]);

/**
 * Gera nó de registro
 */
export const generateRegistrationNode = (
  signalCreds: any,
  config: any
) => {
  // the app version needs to be md5 hashed
  // and passed in
  const appVersionBuf = createHash('md5')
    .update(config.version.join('.')) // join as string
    .digest();

  const companion = {
    os: config.browser[0],
    platformType: getPlatformType(config.browser[1]),
    requireFullSync: config.syncFullHistory
  };

  const companionProto = waproto.DeviceProps.encode(companion).finish();

  const registerPayload = {
    connectType: waproto.ClientPayload.ConnectType.WIFI_UNKNOWN,
    connectReason: waproto.ClientPayload.ConnectReason.USER_ACTIVATED,
    userAgent: getUserAgent(config),
    webInfo: getWebInfo(config),
    passive: false,
    pull: false,
    devicePairingData: {
      buildHash: appVersionBuf,
      deviceProps: companionProto,
      eRegid: encodeBigEndian(signalCreds.registrationId),
      eKeytype: KEY_BUNDLE_TYPE,
      eIdent: signalCreds.signedIdentityKey.public,
      eSkeyId: encodeBigEndian(signalCreds.signedPreKey.keyId, 3),
      eSkeyVal: signalCreds.signedPreKey.keyPair.public,
      eSkeySig: signalCreds.signedPreKey.signature
    }
  };

  return waproto.ClientPayload.create(registerPayload);
};

/**
 * Obtém user agent
 */
const getUserAgent = (config: any) => {
  return {
    platform: waproto.ClientPayload.UserAgent.Platform.WEB,
    appVersion: {
      primary: config.version[0],
      secondary: config.version[1],
      tertiary: config.version[2]
    },
    mcc: '000',
    mnc: '000',
    osVersion: '0.1',
    manufacturer: '',
    device: 'Desktop',
    osBuildNumber: '0.1',
    phoneId: '',
    releaseChannel: waproto.ClientPayload.UserAgent.ReleaseChannel.RELEASE,
    localeLanguageIso6391: 'en',
    localeCountryIso31661Alpha2: config.countryCode || 'US'
  };
};

/**
 * Obtém informações web
 */
const getWebInfo = (config: any) => {
  const PLATFORM_MAP: { [key: string]: any } = {
    'Mac OS': waproto.ClientPayload.WebInfo.WebSubPlatform.DARWIN,
    Windows: waproto.ClientPayload.WebInfo.WebSubPlatform.WIN32
  };

  let webSubPlatform = waproto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER;
  if (config.syncFullHistory && PLATFORM_MAP[config.browser[0]]) {
    webSubPlatform = PLATFORM_MAP[config.browser[0]];
  }

  return { webSubPlatform };
};

/**
 * Obtém tipo de plataforma
 */
export const getPlatformType = (platform: string) => {
  const platformType = platform.toUpperCase();
  return (
    waproto.DeviceProps.PlatformType[platformType as keyof typeof waproto.DeviceProps.PlatformType] ||
    waproto.DeviceProps.PlatformType.DESKTOP
  );
};

/**
 * Codifica big endian
 */
const encodeBigEndian = (value: number, bytes: number = 4): Buffer => {
  const buffer = Buffer.allocUnsafe(bytes);
  buffer.writeUIntBE(value, 0, bytes);
  return buffer;
};