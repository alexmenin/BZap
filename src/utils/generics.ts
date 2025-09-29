// generics.ts - Utilitários genéricos baseados no Baileys-master

import { Boom } from '@hapi/boom';
import { randomBytes } from 'crypto';
import { platform, release } from 'os';
import { waproto } from '@wppconnect/wa-proto';

// Mapeamento de plataformas
const PLATFORM_MAP = {
  aix: 'AIX',
  darwin: 'Mac OS',
  win32: 'Windows',
  android: 'Android',
  freebsd: 'FreeBSD',
  openbsd: 'OpenBSD',
  sunos: 'Solaris',
  linux: undefined,
  haiku: undefined,
  cygwin: undefined,
  netbsd: undefined
};

// Tipos de navegadores baseados no Baileys
export const Browsers = {
  ubuntu: (browser: string) => ['Ubuntu', browser, '22.04.4'],
  macOS: (browser: string) => ['Mac OS', browser, '14.4.1'],
  baileys: (browser: string) => ['Baileys', browser, '6.5.0'],
  windows: (browser: string) => ['Windows', browser, '10.0.22631'],
  appropriate: (browser: string) => [PLATFORM_MAP[platform() as keyof typeof PLATFORM_MAP] || 'Ubuntu', browser, release()]
};

/**
 * Obtém o ID da plataforma baseado no navegador
 */
export const getPlatformId = (browser: string) => {
  const platformType = waproto.DeviceProps.PlatformType[browser.toUpperCase() as any];
  return platformType ? platformType.toString() : '1'; // chrome
};

/**
 * Utilitários para serialização JSON com Buffer
 */
export const BufferJSON = {
  replacer: (k: any, value: any) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array || value?.type === 'Buffer') {
      return {
        type: 'Buffer',
        data: Array.from(value)
      };
    }
    return value;
  },
  reviver: (_: any, value: any) => {
    if (typeof value === 'object' && value && value.type === 'Buffer' && Array.isArray(value.data)) {
      return Buffer.from(value.data);
    }
    return value;
  }
};



/**
 * Adiciona padding aleatório (máximo 16 bytes)
 */
export const writeRandomPadMax16 = (msg: Uint8Array) => {
  const pad = randomBytes(1 + Math.floor(Math.random() * 15));
  return Buffer.concat([msg, pad, Buffer.from([pad.length])]);
};

/**
 * Remove padding aleatório
 */
export const unpadRandomMax16 = (e: Uint8Array | Buffer) => {
  const buffer = Buffer.from(e);
  if (buffer.length === 0) {
    throw new Boom('Invalid message length', { statusCode: 400 });
  }
  
  const padLength = buffer[buffer.length - 1];
  if (padLength > buffer.length - 1) {
    throw new Boom('Invalid pad length', { statusCode: 400 });
  }
  
  return buffer.slice(0, buffer.length - padLength - 1);
};

/**
 * Codifica mensagem WAMessage usando protobuf
 */
export const encodeWAMessage = (message: waproto.IMessage) => 
  writeRandomPadMax16(waproto.Message.encode(message).finish());

/**
 * Gera ID de registro aleatório
 */
export const generateRegistrationId = (): number => {
  return Math.floor(Math.random() * 16777215) + 1;
};

/**
 * Codifica número em big endian
 */
export const encodeBigEndian = (e: number, t = 4) => {
  const buffer = Buffer.allocUnsafe(t);
  for (let i = t - 1; i >= 0; i--) {
    buffer[i] = e & 255;
    e >>>= 8;
  }
  return buffer;
};

/**
 * Converte Long para number
 */
export const toNumber = (t: any): number =>
  typeof t === 'object' && t ? ('toNumber' in t ? t.toNumber() : t.low) : t || 0;

/**
 * Obtém timestamp Unix em segundos
 */
export const unixTimestampSeconds = (date: Date = new Date()) => Math.floor(date.getTime() / 1000);

/**
 * Delay com Promise
 */
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));



/**
 * Gera ID de mensagem
 */
export const generateMessageID = () => '3EB0' + randomBytes(18).toString('hex').toUpperCase();

/**
 * Remove propriedades undefined de um objeto
 */
export function trimUndefined(obj: { [_: string]: any }) {
  for (const key in obj) {
    if (obj[key] === undefined) {
      delete obj[key];
    }
  }
  return obj;
}