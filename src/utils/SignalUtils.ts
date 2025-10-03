/**
 * Utilitários para Signal Protocol
 */

import { Logger } from './Logger';
import { SignalProtocolAddress } from '../crypto/SignalProtocolStore';

/**
 * Analisa um addressName no formato "jid.device" e retorna os componentes separados
 * @param addressName String no formato "jid.device"
 * @returns Objeto com jid e device extraídos
 * @throws Error se o formato for inválido
 */
export function parseAddressName(addressName: string): { jid: string; device: number } {
  if (!addressName || !addressName.includes('.')) {
    Logger.error(`❌ [SIGNAL_FLOW] Formato de addressName inválido: ${addressName}`);
    throw new Error(`Invalid addressName format: ${addressName}`);
  }

  const [jid, deviceStr] = addressName.split('.');
  const device = parseInt(deviceStr, 10);

  if (isNaN(device)) {
    Logger.error(`❌ [SIGNAL_FLOW] Device inválido em addressName: ${addressName}`);
    throw new Error(`Invalid device in addressName: ${addressName}`);
  }

  return { jid, device };
}

/**
 * Extrai o device ID de um JID, se presente
 * @param jid JID completo que pode conter informação de device
 * @returns Número do device ou undefined se não encontrado
 */
export function parseDeviceFromJid(jid: string): number {
  if (!jid) return 0;

  const clean = jid.split('@')[0];

  // jid:device
  if (clean.includes(':')) {
    const parts = clean.split(':');
    const deviceStr = parts[parts.length - 1];
    const device = parseInt(deviceStr, 10);
    return isNaN(device) ? 0 : device;
  }

  // jid.device
  if (clean.includes('.')) {
    const parts = clean.split('.');
    const deviceStr = parts[parts.length - 1];
    const device = parseInt(deviceStr, 10);
    return isNaN(device) ? 0 : device;
  }

  // padrão sem device → sempre 0
  return 0;
}


/**
 * Normaliza um JID para o formato padrão, removendo informações de device
 * @param jid JID que pode conter informação de device
 * @returns JID normalizado sem informação de device
 */
export function normalizeJid(jid: string): string {
  if (!jid) return jid;

  const clean = jid.split('@')[0];

  // Remove device ID do formato jid:device
  if (clean.includes(':')) {
    return clean.split(':')[0];
  }

  // Remove device ID do formato jid.device
  if (clean.includes('.')) {
    const parts = clean.split('.');
    // Verifica se a última parte é um número (device)
    const lastPart = parts[parts.length - 1];
    if (!isNaN(parseInt(lastPart, 10))) {
      return parts.slice(0, -1).join('.');
    }
  }

  return clean;
}

/**
 * Cria um endereço de protocolo Signal com fallback para device 0
 * @param jid JID do contato
 * @param device Device ID (opcional)
 * @returns SignalProtocolAddress
 */
/**
 * Cria um endereço de protocolo Signal compatível com libsignal
 * - Remove qualquer sufixo @s.whatsapp.net, @lid, @g.us etc.
 * - Extrai o device ID corretamente (tanto formato :device quanto .device)
 * - Faz fallback para deviceId=0
 */
export function createSignalProtocolAddress(jid: string, deviceId?: number): SignalProtocolAddress {
  const base = jidToSignalAddress(jid);
  const effectiveDevice = deviceId ?? base.deviceId ?? 0;
  Logger.debug(`🪪 [SIGNAL_UTILS] Address normalizado: name=${base.name}, deviceId=${effectiveDevice}`);
  return { name: base.name, deviceId: effectiveDevice };
}





/**
 * Remove padding PKCS7 de um buffer
 * @param buffer Buffer com padding
 * @returns Buffer sem padding
 */
export const unpadRandomMax16 = (buffer: Buffer): Buffer => {
  if (buffer.length === 0) {
    return buffer;
  }

  // Obtém o último byte que indica o tamanho do padding
  const paddingLength = buffer[buffer.length - 1];

  // Valida se o padding é válido (1-16 bytes)
  if (paddingLength < 1 || paddingLength > 16) {
    throw new Error(`Invalid padding length: ${paddingLength}`);
  }

  // Valida se há bytes suficientes para o padding
  if (paddingLength > buffer.length) {
    throw new Error(`Padding length ${paddingLength} exceeds buffer length ${buffer.length}`);
  }

  // Verifica se todos os bytes de padding são iguais ao tamanho do padding
  for (let i = buffer.length - paddingLength; i < buffer.length; i++) {
    if (buffer[i] !== paddingLength) {
      throw new Error(`Invalid padding byte at position ${i}: expected ${paddingLength}, got ${buffer[i]}`);
    }
  }

  // Remove o padding
  return buffer.subarray(0, buffer.length - paddingLength);
};

/**
 * Adiciona padding PKCS7 a um buffer
 * @param buffer Buffer original
 * @param blockSize Tamanho do bloco (padrão: 16)
 * @returns Buffer com padding
 */
export const padRandomMax16 = (buffer: Buffer, blockSize: number = 16): Buffer => {
  const paddingLength = blockSize - (buffer.length % blockSize);
  const padding = Buffer.alloc(paddingLength, paddingLength);
  return Buffer.concat([buffer, padding]);
};

/**
 * Converte JID para formato Signal Protocol Address
 * @param jid JID do WhatsApp
 * @returns Endereço Signal Protocol
 */
export const jidToSignalAddress = (jid: string): { name: string; deviceId: number } => {
  if (!jid) throw new Error('jid vazio');

  // Remove sufixos do WhatsApp
  const clean = jid.split('@')[0];

  let name = clean;
  let deviceId = 0;

  // jid:device
  if (clean.includes(':')) {
    const [base, devStr] = clean.split(':');
    name = base;
    deviceId = parseInt(devStr, 10) || 0;
  }
  // jid.device
  else if (clean.includes('.')) {
    const parts = clean.split('.');
    const last = parts[parts.length - 1];
    if (!isNaN(parseInt(last, 10))) {
      deviceId = parseInt(last, 10);
      name = parts.slice(0, -1).join('.');
    }
  }

  return { name, deviceId };
};

/**
 * Converte endereço Signal Protocol para JID
 * @param address Endereço Signal Protocol
 * @param isGroup Se é um grupo
 * @returns JID do WhatsApp
 */
export const signalAddressToJid = (address: { name: string; deviceId: number }, isGroup: boolean = false): string => {
  const suffix = isGroup ? '@g.us' : '@s.whatsapp.net';

  if (address.deviceId > 0) {
    return `${address.name}:${address.deviceId}${suffix}`;
  }

  return `${address.name}${suffix}`;
};